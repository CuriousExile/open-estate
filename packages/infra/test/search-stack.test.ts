import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AdminStack } from '../src/admin-stack';
import { ApiStack } from '../src/api-stack';
import { DEFAULT_CONFIG_DIR, resolveEnvironment, resolvePlatformSettings } from '../src/config';
import { DataStack, frontendOriginParameterName } from '../src/data-stack';
import {
  FrontendStack,
  frontendRuntimeSources,
  tourProvidersFromConfigFiles,
} from '../src/frontend-stack';
import { connectorsFromConfigFiles, IngestionStack } from '../src/ingestion-stack';
import {
  INDEXER_INDEX_PERMISSIONS,
  OPENSEARCH_INDEX_NAME,
  READER_INDEX_PERMISSIONS,
  searchCollectionName,
} from '../src/opensearch-access';
import { SearchStack } from '../src/search-stack';

const CDK_CONTEXT = (
  JSON.parse(readFileSync(path.join(__dirname, '../cdk.json'), 'utf8')) as {
    context: Record<string, unknown>;
  }
).context;

/** Data, Search (if enabled) and Api wired like `app.ts`; bundling skipped as in stacks.test.ts. */
function synthApp(envName: string, context: Record<string, unknown> = {}) {
  const config = resolveEnvironment(envName);
  const app = new App({ context: { ...CDK_CONTEXT, 'aws:cdk:bundling-stacks': [], ...context } });
  const settings = resolvePlatformSettings((key) => app.node.tryGetContext(key));
  const data = new DataStack(app, `${config.stackPrefix}-Data`, { environment: config, settings });
  const search =
    settings.searchProvider === 'opensearch'
      ? new SearchStack(app, `${config.stackPrefix}-Search`, {
          envName: config.envName,
          listings: data.listingsTable,
          removalPolicy: config.removalPolicy,
        })
      : undefined;
  const api = new ApiStack(app, `${config.stackPrefix}-Api`, {
    tables: {
      listings: data.listingsTable,
      apiKeys: data.apiKeysTable,
      rateLimitCounters: data.rateLimitCountersTable,
    },
    config: { configBucket: data.configBucket, parameterNames: data.parameterNames },
    cors: { frontendOriginParameter: frontendOriginParameterName(envName), allowedOrigins: [] },
    stageName: config.stageName,
    removalPolicy: config.removalPolicy,
    searchProvider: settings.searchProvider,
    ...(search && { openSearch: search.target }),
    wafRateLimit: settings.wafRateLimit,
  });
  app.synth(); // fails on a dependency cycle
  return { app, data, search, api };
}

/** {@link synthApp} with `searchProvider=opensearch`; the SearchStack is always present. */
function synthWithSearch(envName: string) {
  const result = synthApp(envName, { searchProvider: 'opensearch' });
  if (result.search === undefined) throw new Error('SearchStack missing');
  return { ...result, search: result.search };
}

type Statement = { Action: string | string[]; Resource: unknown };
/** IAM statements attached to the role of the function whose logical id starts with `prefix`. */
function statements(template: Template, prefix: string): Statement[] {
  const [fn] = Object.entries(template.findResources('AWS::Lambda::Function')).filter(([id]) =>
    id.startsWith(prefix),
  );
  const role = (fn?.[1] as { Properties: { Role: { 'Fn::GetAtt': [string] } } }).Properties.Role[
    'Fn::GetAtt'
  ][0];
  return Object.values(template.findResources('AWS::IAM::Policy'))
    .map(
      (p) =>
        (
          p as {
            Properties: { Roles: { Ref: string }[]; PolicyDocument: { Statement: Statement[] } };
          }
        ).Properties,
    )
    .filter((p) => p.Roles.some((r) => r.Ref === role))
    .flatMap((p) => p.PolicyDocument.Statement);
}

/** Data access policies of a template, with the policy JSON resolved and parsed. */
function dataAccessPolicies(stack: Stack) {
  return Object.values(
    Template.fromStack(stack).findResources('AWS::OpenSearchServerless::AccessPolicy'),
  ).map((r) => {
    const props = (r as { Properties: { Name: string; Type: string; Policy: unknown } }).Properties;
    return { name: props.Name, type: props.Type, policy: props.Policy };
  });
}

describe('SearchStack activation (Req 9.2, 11.3)', () => {
  it('is absent by default: no stream on Listings, no AOSS access in the API', () => {
    const { app, data, search, api } = synthApp('dev');
    expect(search).toBeUndefined();
    expect(app.node.children.map((c) => c.node.id)).not.toContain('OpenEstate-dev-Search');
    Template.fromStack(data).hasResourceProperties('AWS::DynamoDB::GlobalTable', {
      KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
      StreamSpecification: Match.absent(),
    });
    expect(JSON.stringify(Template.fromStack(api).toJSON())).not.toMatch(/aoss|OPENSEARCH_/);
  });

  it('enables the NEW_AND_OLD_IMAGES stream on Listings only', () => {
    const { data } = synthWithSearch('dev');
    const tables = Object.values(
      Template.fromStack(data).findResources('AWS::DynamoDB::GlobalTable'),
    )
      .map((r) => (r as { Properties: Record<string, unknown> }).Properties)
      .filter((p) => p['StreamSpecification'] !== undefined);
    expect(tables).toHaveLength(1);
    expect(tables[0]).toMatchObject({
      KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
      StreamSpecification: { StreamViewType: 'NEW_AND_OLD_IMAGES' },
    });
  });

  it.each(['dev', 'prod'])(
    'wires %s without cycle: Api depends on Search, Search on Data',
    (env) => {
      const { data, search, api } = synthWithSearch(env);
      const deps = (s: Stack) => s.dependencies.map((d) => d.stackName);
      expect(deps(api)).toEqual(expect.arrayContaining([data.stackName, search.stackName]));
      expect(deps(search)).toEqual([data.stackName]);
    },
  );
});

describe('SearchStack resources', () => {
  const { search: stack, api } = synthWithSearch('dev');
  const template = Template.fromStack(stack);
  const name = searchCollectionName('dev');

  it('creates a SEARCH collection after its encryption and network policy', () => {
    template.hasResource('AWS::OpenSearchServerless::Collection', {
      Properties: { Name: name, Type: 'SEARCH', StandbyReplicas: 'DISABLED' },
      DependsOn: Match.arrayWith([
        Match.stringLikeRegexp('^EncryptionPolicy'),
        Match.stringLikeRegexp('^NetworkPolicy'),
      ]),
    });
    const policies = Object.values(
      template.findResources('AWS::OpenSearchServerless::SecurityPolicy'),
    ).map((r) => (r as { Properties: { Type: string; Policy: string } }).Properties);
    const policy = (type: string): unknown =>
      JSON.parse(policies.find((p) => p.Type === type)?.Policy ?? 'null');
    const rules = [{ ResourceType: 'collection', Resource: [`collection/${name}`] }];
    expect(policy('encryption')).toEqual({ Rules: rules, AWSOwnedKey: true });
    expect(policy('network')).toEqual([{ Rules: rules, AllowFromPublic: true }]);
  });

  it('runs the indexer with the collection endpoint and index', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x',
      Environment: {
        Variables: Match.objectLike({
          OPENSEARCH_ENDPOINT: {
            'Fn::GetAtt': [Match.stringLikeRegexp('^Collection'), 'CollectionEndpoint'],
          },
          OPENSEARCH_INDEX: OPENSEARCH_INDEX_NAME,
        }),
      },
    });
  });

  it('maps the Listings stream with partial batch failures, bounded retries and an encrypted DLQ', () => {
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      StartingPosition: 'TRIM_HORIZON',
      BatchSize: 100,
      MaximumBatchingWindowInSeconds: 2,
      BisectBatchOnFunctionError: true,
      FunctionResponseTypes: ['ReportBatchItemFailures'],
      MaximumRetryAttempts: 10,
      MaximumRecordAgeInSeconds: 86_400,
      DestinationConfig: {
        OnFailure: {
          Destination: { 'Fn::GetAtt': [Match.stringLikeRegexp('^IndexerDeadLetterQueue'), 'Arn'] },
        },
      },
    });
    template.hasResourceProperties('AWS::SQS::Queue', { SqsManagedSseEnabled: true });
  });

  it('grants the indexer role APIAccessAll and index write access', () => {
    expect(statements(template, 'IndexerFunction')).toContainEqual(
      expect.objectContaining({
        Action: 'aoss:APIAccessAll',
        Resource: { 'Fn::GetAtt': [expect.stringMatching(/^Collection/), 'Arn'] },
      }),
    );
    const [policy] = dataAccessPolicies(stack);
    expect(policy).toMatchObject({ name: `${name}-idx`, type: 'data' });
    expect(JSON.stringify(policy?.policy)).toContain(`index/${name}/${OPENSEARCH_INDEX_NAME}`);
    for (const permission of INDEXER_INDEX_PERMISSIONS) {
      expect(JSON.stringify(policy?.policy)).toContain(permission);
    }
  });

  it('gives the API and MCP Lambda the target and their own read access policy', () => {
    const apiTemplate = Template.fromStack(api);
    for (const prefix of ['ListingsFunction', 'McpFunction']) {
      expect(statements(apiTemplate, prefix)).toContainEqual(
        expect.objectContaining({ Action: 'aoss:APIAccessAll' }),
      );
    }
    expect(
      Object.values(apiTemplate.findResources('AWS::Lambda::Function')).filter((r) =>
        JSON.stringify(r).includes('OPENSEARCH_ENDPOINT'),
      ),
    ).toHaveLength(2);
    const [policy] = dataAccessPolicies(api);
    expect(policy).toMatchObject({ name: `${name}-api`, type: 'data' });
    const document = JSON.stringify(policy?.policy);
    for (const permission of READER_INDEX_PERMISSIONS) expect(document).toContain(permission);
    expect(document).not.toContain('aoss:WriteDocument');
    expect(document).toMatch(/ListingsFunctionServiceRole.*McpFunctionServiceRole/);
  });

  it('keeps standby replicas and retains the collection in prod', () => {
    const prodTemplate = Template.fromStack(synthWithSearch('prod').search);
    prodTemplate.hasResource('AWS::OpenSearchServerless::Collection', {
      Properties: { StandbyReplicas: 'ENABLED' },
      DeletionPolicy: 'Retain',
    });
  });
});

// --- Whole app (all six stacks wired like `app.ts`) ---------------------------------------------

/** One enabled connector, so the app also has connector roles (the default config has none). */
const CONNECTOR = {
  id: 'partner-db',
  type: 'relational-db',
  module: 'relational-db',
  enabled: true,
  schedule: 'rate(1 hour)',
  timeoutSeconds: 600,
  settings: {},
  secretRef: 'open-estate/partner-db',
};

type CfnResource = {
  Type: string;
  Properties?: Record<string, unknown>;
  DeletionPolicy?: string;
};
type CfnTemplate = {
  Resources: Record<string, CfnResource>;
  Outputs?: Record<string, { Value: unknown; Export?: { Name: string } }>;
};
type Located = { stack: string; id: string; resource: CfnResource };

/**
 * Data, Search (if enabled), Api, Ingestion, Admin and Frontend wired exactly like `app.ts`,
 * synthesized into a temporary directory; returns the templates by stack name.
 */
function synthFullApp(envName: string, searchProvider: 'dynamodb' | 'opensearch') {
  const dir = mkdtempSync(path.join(tmpdir(), 'open-estate-search-app-'));
  try {
    const configDir = path.join(dir, 'config');
    cpSync(DEFAULT_CONFIG_DIR, configDir, { recursive: true });
    writeFileSync(path.join(configDir, 'connectors.json'), JSON.stringify([CONNECTOR]));
    const assetDir = path.join(dir, 'assets');
    mkdirSync(assetDir);
    writeFileSync(path.join(assetDir, 'index.html'), '<!doctype html>');

    const config = resolveEnvironment(envName);
    const app = new App({
      outdir: path.join(dir, 'cdk.out'),
      context: {
        ...CDK_CONTEXT,
        'aws:cdk:bundling-stacks': [],
        configDir,
        frontendAssetDir: assetDir,
        searchProvider,
      },
    });
    const settings = resolvePlatformSettings((key) => app.node.tryGetContext(key));
    const frontendOriginParameter = frontendOriginParameterName(config.envName);
    const data = new DataStack(app, `${config.stackPrefix}-Data`, {
      environment: config,
      settings,
    });
    const search =
      settings.searchProvider === 'opensearch'
        ? new SearchStack(app, `${config.stackPrefix}-Search`, {
            envName: config.envName,
            listings: data.listingsTable,
            removalPolicy: config.removalPolicy,
          })
        : undefined;
    const api = new ApiStack(app, `${config.stackPrefix}-Api`, {
      tables: {
        listings: data.listingsTable,
        apiKeys: data.apiKeysTable,
        rateLimitCounters: data.rateLimitCountersTable,
      },
      config: { configBucket: data.configBucket, parameterNames: data.parameterNames },
      cors: { frontendOriginParameter, allowedOrigins: settings.corsAllowedOrigins },
      stageName: config.stageName,
      removalPolicy: config.removalPolicy,
      searchProvider: settings.searchProvider,
      ...(search && { openSearch: search.target }),
      wafRateLimit: settings.wafRateLimit,
    });
    const ingestion = new IngestionStack(app, `${config.stackPrefix}-Ingestion`, {
      tables: { listings: data.listingsTable, deletionBlocklist: data.deletionBlocklistTable },
      configBucket: data.configBucket,
      connectors: connectorsFromConfigFiles(data.configFiles),
      removalPolicy: config.removalPolicy,
    });
    new AdminStack(app, `${config.stackPrefix}-Admin`, {
      tables: {
        listings: data.listingsTable,
        apiKeys: data.apiKeysTable,
        deletionRequests: data.deletionRequestsTable,
        deletionBlocklist: data.deletionBlocklistTable,
        auditLog: data.auditLogTable,
      },
      parameterNames: data.parameterNames,
      reloadableFunctions: [
        api.listingsFunction,
        api.mcpFunction,
        ...ingestion.connectors.map((connector) => connector.function),
      ],
      stageName: config.stageName,
      removalPolicy: config.removalPolicy,
    });
    new FrontendStack(app, `${config.stackPrefix}-Frontend`, {
      assetDir: settings.frontendAssetDir,
      runtimeSources: frontendRuntimeSources(settings.i18nConfigFile),
      apiUrl: api.api.url,
      tourProviders: tourProvidersFromConfigFiles(data.configFiles),
      frontendOriginParameter,
      removalPolicy: config.removalPolicy,
      priceClass: settings.frontendPriceClass,
    });
    // Templates are read lazily from the outdir: load them before it is removed.
    const templates: Record<string, CfnTemplate> = Object.fromEntries(
      app.synth().stacks.map((s) => [s.stackName, s.template as CfnTemplate]),
    );
    return { templates, prefix: config.stackPrefix };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** All resources of `type` across the app, with their stack and logical id. */
function resourcesOfType(templates: Record<string, CfnTemplate>, type: string): Located[] {
  return Object.entries(templates).flatMap(([stack, template]) =>
    Object.entries(template.Resources)
      .filter(([, resource]) => resource.Type === type)
      .map(([id, resource]) => ({ stack, id, resource })),
  );
}

/** Logical id of the Lambda function whose id starts with `prefix`, and of its role. */
function functionAndRole(template: CfnTemplate, prefix: string): { fn: string; role: string } {
  const matches = Object.entries(template.Resources).filter(
    ([id, r]) => r.Type === 'AWS::Lambda::Function' && id.startsWith(prefix),
  );
  expect(matches).toHaveLength(1);
  const [[fn, resource]] = matches as [[string, CfnResource]];
  const role = (resource.Properties?.['Role'] as { 'Fn::GetAtt': [string, string] })['Fn::GetAtt'];
  return { fn, role: role[0] };
}

type PolicyStatementJson = { Action: string | string[]; Resource: unknown; Effect: string };
const actionsOf = (statement: PolicyStatementJson): string[] =>
  typeof statement.Action === 'string' ? [statement.Action] : statement.Action;

/** IAM statements (`AWS::IAM::Policy`) attached to the role `roleId` of `template`. */
function roleStatements(template: CfnTemplate, roleId: string): PolicyStatementJson[] {
  return Object.values(template.Resources)
    .filter((r) => r.Type === 'AWS::IAM::Policy')
    .map(
      (r) =>
        r.Properties as {
          Roles: { Ref: string }[];
          PolicyDocument: { Statement: PolicyStatementJson[] };
        },
    )
    .filter((p) => p.Roles.some((role) => role.Ref === roleId))
    .flatMap((p) => p.PolicyDocument.Statement);
}

/**
 * Parses a policy JSON built by `Stack.toJsonString`: literals and `Fn::GetAtt [id, attr]` parts
 * of an `Fn::Join`, the latter replaced by `<id.attr>`.
 */
function parsePolicy(policy: unknown): unknown {
  if (typeof policy === 'string') return JSON.parse(policy);
  const [separator, parts] = (policy as { 'Fn::Join': [string, unknown[]] })['Fn::Join'];
  const text = parts
    .map((part) => {
      if (typeof part === 'string') return part;
      const getAtt = (part as { 'Fn::GetAtt'?: [string, string] })['Fn::GetAtt'];
      if (getAtt === undefined) throw new Error(`Unexpected policy part ${JSON.stringify(part)}`);
      return `<${getAtt.join('.')}>`;
    })
    .join(separator);
  return JSON.parse(text);
}

/**
 * Cross-stack reference to the output of `stackName` whose value is `value`. The app uses weak
 * references (`@aws-cdk/core:defaultCrossStackReferences`): `Fn::GetStackOutput`, no export.
 */
function stackOutputRef(templates: Record<string, CfnTemplate>, stackName: string, value: unknown) {
  const names = Object.entries(templates[stackName]?.Outputs ?? {})
    .filter(([, output]) => JSON.stringify(output.Value) === JSON.stringify(value))
    .map(([outputName]) => outputName);
  expect(names).toHaveLength(1);
  return {
    'Fn::GetStackOutput': {
      StackName: stackName,
      Region: { Ref: 'AWS::Region' },
      OutputName: names[0],
    },
  };
}

/** AOSS names (collections and policies): lower-case letter first, `[a-z0-9-]`, 3–32 chars. */
const AOSS_NAME = /^[a-z][a-z0-9-]{2,31}$/;

describe.each(['dev', 'prod'])('default searchProvider (dynamodb), whole app in %s', (env) => {
  const { templates, prefix } = synthFullApp(env, 'dynamodb');

  it('has no SearchStack', () => {
    expect(Object.keys(templates).sort()).toEqual(
      ['Admin', 'Api', 'Data', 'Frontend', 'Ingestion'].map((s) => `${prefix}-${s}`),
    );
  });

  it.each(Object.keys(templates))(
    '%s: no OpenSearch resource, stream, stream trigger, aoss permission or OPENSEARCH_ env',
    (stackName) => {
      const template = templates[stackName] as CfnTemplate;
      const types = Object.values(template.Resources).map((r) => r.Type);
      expect(types.filter((t) => t.startsWith('AWS::OpenSearchServerless::'))).toEqual([]);
      expect(types).not.toContain('AWS::Lambda::EventSourceMapping');
      const json = JSON.stringify(template);
      expect(json).not.toContain('StreamSpecification');
      expect(json).not.toMatch(/aoss|OPENSEARCH_/);
    },
  );
});

describe.each(['dev', 'prod'])('searchProvider=opensearch, whole app in %s', (env) => {
  const { templates, prefix } = synthFullApp(env, 'opensearch');
  const searchName = `${prefix}-Search`;
  const apiName = `${prefix}-Api`;
  const dataName = `${prefix}-Data`;
  const search = templates[searchName] as CfnTemplate;
  const apiTemplate = templates[apiName] as CfnTemplate;
  const name = searchCollectionName(env);
  const indexer = functionAndRole(search, 'IndexerFunction');
  const listings = functionAndRole(apiTemplate, 'ListingsFunction');
  const mcp = functionAndRole(apiTemplate, 'McpFunction');
  const [collection] = resourcesOfType(templates, 'AWS::OpenSearchServerless::Collection');
  const collectionArn = { 'Fn::GetAtt': [collection?.id, 'Arn'] };

  it('adds the SearchStack to the five default stacks', () => {
    expect(Object.keys(templates).sort()).toEqual(
      ['Admin', 'Api', 'Data', 'Frontend', 'Ingestion', 'Search'].map((s) => `${prefix}-${s}`),
    );
  });

  it('creates exactly one collection, encryption and network policy, all in the SearchStack', () => {
    const collections = resourcesOfType(templates, 'AWS::OpenSearchServerless::Collection');
    expect(collections.map((c) => [c.stack, c.resource.Properties?.['Name']])).toEqual([
      [searchName, name],
    ]);
    const security = resourcesOfType(templates, 'AWS::OpenSearchServerless::SecurityPolicy');
    expect(
      security.map((p) => [
        p.stack,
        p.resource.Properties?.['Type'],
        p.resource.Properties?.['Name'],
      ]),
    ).toEqual(
      expect.arrayContaining([
        [searchName, 'encryption', `${name}-enc`],
        [searchName, 'network', `${name}-net`],
      ]),
    );
    expect(security).toHaveLength(2);
    // Nothing else of AOSS (no VPC endpoint, lifecycle or security config).
    const aossTypes = Object.values(templates)
      .flatMap((t) => Object.values(t.Resources).map((r) => r.Type))
      .filter((t) => t.startsWith('AWS::OpenSearchServerless::'))
      .sort();
    expect(aossTypes).toEqual([
      'AWS::OpenSearchServerless::AccessPolicy',
      'AWS::OpenSearchServerless::AccessPolicy',
      'AWS::OpenSearchServerless::Collection',
      'AWS::OpenSearchServerless::SecurityPolicy',
      'AWS::OpenSearchServerless::SecurityPolicy',
    ]);
  });

  it('creates two data access policies with exact documents: indexer writes, API/MCP read', () => {
    const policies = resourcesOfType(templates, 'AWS::OpenSearchServerless::AccessPolicy').map(
      (p) => ({
        stack: p.stack,
        name: p.resource.Properties?.['Name'],
        type: p.resource.Properties?.['Type'],
        document: parsePolicy(p.resource.Properties?.['Policy']),
      }),
    );
    const resource = [`index/${name}/listings`];
    expect(policies).toHaveLength(2);
    expect(policies).toEqual(
      expect.arrayContaining([
        {
          stack: searchName,
          name: `${name}-idx`,
          type: 'data',
          document: [
            {
              Rules: [
                {
                  ResourceType: 'index',
                  Resource: resource,
                  Permission: [
                    'aoss:CreateIndex',
                    'aoss:DescribeIndex',
                    'aoss:UpdateIndex',
                    'aoss:WriteDocument',
                  ],
                },
              ],
              Principal: [`<${indexer.role}.Arn>`],
            },
          ],
        },
        {
          stack: apiName,
          name: `${name}-api`,
          type: 'data',
          document: [
            {
              Rules: [
                {
                  ResourceType: 'index',
                  Resource: resource,
                  Permission: ['aoss:DescribeIndex', 'aoss:ReadDocument'],
                },
              ],
              Principal: [`<${listings.role}.Arn>`, `<${mcp.role}.Arn>`],
            },
          ],
        },
      ]),
    );
  });

  it('uses unique, valid AOSS names of at most 32 characters', () => {
    const names = resourcesOfType(templates, 'AWS::OpenSearchServerless::AccessPolicy')
      .concat(resourcesOfType(templates, 'AWS::OpenSearchServerless::SecurityPolicy'))
      .concat(resourcesOfType(templates, 'AWS::OpenSearchServerless::Collection'))
      .map((r) => r.resource.Properties?.['Name'] as string);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n).toMatch(AOSS_NAME);
  });

  it('grants aoss:APIAccessAll on the collection ARN to the indexer, Listings and MCP roles only', () => {
    const grants = Object.entries(templates).flatMap(([stack, template]) =>
      Object.values(template.Resources)
        .filter((r) => r.Type === 'AWS::IAM::Policy')
        .flatMap((r) => {
          const props = r.Properties as {
            Roles: { Ref: string }[];
            PolicyDocument: { Statement: PolicyStatementJson[] };
          };
          return props.PolicyDocument.Statement.filter((s) =>
            actionsOf(s).some((a) => a.startsWith('aoss')),
          ).map((s) => ({
            stack,
            roles: props.Roles.map((role) => role.Ref),
            actions: actionsOf(s),
            resource: s.Resource,
            effect: s.Effect,
          }));
        }),
    );
    const importedArn = stackOutputRef(templates, searchName, collectionArn);
    expect(grants).toHaveLength(3);
    expect(grants).toEqual(
      expect.arrayContaining([
        {
          stack: searchName,
          roles: [indexer.role],
          actions: ['aoss:APIAccessAll'],
          resource: collectionArn,
          effect: 'Allow',
        },
        ...[listings.role, mcp.role].map((role) => ({
          stack: apiName,
          roles: [role],
          actions: ['aoss:APIAccessAll'],
          resource: importedArn,
          effect: 'Allow',
        })),
      ]),
    );
    // Admin, connector, data and frontend roles: no AOSS access in any form (IAM or data policy).
    for (const stack of ['Admin', 'Ingestion', 'Data', 'Frontend']) {
      expect(JSON.stringify(templates[`${prefix}-${stack}`])).not.toMatch(/aoss|OPENSEARCH_/);
    }
  });

  it('triggers the indexer from the Listings stream of the DataStack only', () => {
    const mappings = resourcesOfType(templates, 'AWS::Lambda::EventSourceMapping');
    expect(mappings.map((m) => m.stack)).toEqual([searchName]);
    const [mapping] = mappings as [Located];
    const streams = resourcesOfType(templates, 'AWS::DynamoDB::GlobalTable').filter(
      (t) => t.resource.Properties?.['StreamSpecification'] !== undefined,
    );
    expect(streams.map((t) => t.stack)).toEqual([dataName]);
    const [table] = streams as [Located];
    expect(mapping.resource.Properties).toMatchObject({
      FunctionName: { Ref: indexer.fn },
      EventSourceArn: stackOutputRef(templates, dataName, {
        'Fn::GetAtt': [table.id, 'StreamArn'],
      }),
    });
    // One batch per shard at a time keeps upsert/delete of the same id in order.
    expect([undefined, 1]).toContain(mapping.resource.Properties?.['ParallelizationFactor']);
  });

  it('lets the indexer read only that stream and send failed batches to its DLQ', () => {
    const statementsOfIndexer = roleStatements(search, indexer.role);
    const streamArn = (
      resourcesOfType(templates, 'AWS::Lambda::EventSourceMapping')[0]?.resource.Properties as {
        EventSourceArn: unknown;
      }
    ).EventSourceArn;
    const dynamo = statementsOfIndexer.filter((s) =>
      actionsOf(s).some((a) => a.startsWith('dynamodb:')),
    );
    expect(dynamo.length).toBeGreaterThan(0);
    for (const statement of dynamo) {
      for (const action of actionsOf(statement)) {
        expect([
          'dynamodb:ListStreams',
          'dynamodb:DescribeStream',
          'dynamodb:GetRecords',
          'dynamodb:GetShardIterator',
        ]).toContain(action);
      }
      // ListStreams has no resource-level scope; everything else is on the stream itself.
      if (!actionsOf(statement).every((a) => a === 'dynamodb:ListStreams')) {
        expect(statement.Resource).toEqual(streamArn);
      }
    }
    const [dlq] = Object.entries(search.Resources).filter(
      ([id, r]) => r.Type === 'AWS::SQS::Queue' && id.startsWith('IndexerDeadLetterQueue'),
    );
    expect(statementsOfIndexer).toContainEqual(
      expect.objectContaining({
        Action: expect.arrayContaining(['sqs:SendMessage']),
        Resource: { 'Fn::GetAtt': [dlq?.[0], 'Arn'] },
      }),
    );
  });

  it('sizes the indexer (512 MB, 60 s, arm64) and keeps its logs for one month', () => {
    const fn = search.Resources[indexer.fn]?.Properties ?? {};
    expect(fn).toMatchObject({ MemorySize: 512, Timeout: 60, Architectures: ['arm64'] });
    const logGroupId = (fn['LoggingConfig'] as { LogGroup: { Ref: string } }).LogGroup.Ref;
    const logGroup = search.Resources[logGroupId];
    expect(logGroup).toMatchObject({
      Type: 'AWS::Logs::LogGroup',
      Properties: { RetentionInDays: 30 },
      DeletionPolicy: env === 'dev' ? 'Delete' : 'Retain',
    });
  });
});

describe('AOSS names with the longest allowed env name', () => {
  const longest = 'a'.repeat(16);

  it('accepts 16 characters and rejects 17 (the budget the policy suffixes rely on)', () => {
    expect(resolveEnvironment(longest).envName).toBe(longest);
    expect(() => resolveEnvironment('a'.repeat(17))).toThrow();
  });

  it('keeps every collection and policy name valid and unique', () => {
    const { search, api } = synthWithSearch(longest);
    const names = [search, api].flatMap((stack) =>
      Object.values(Template.fromStack(stack).toJSON()['Resources'] as Record<string, CfnResource>)
        .filter((r) => r.Type.startsWith('AWS::OpenSearchServerless::'))
        .map((r) => r.Properties?.['Name'] as string),
    );
    expect(names).toHaveLength(5);
    expect(new Set(names).size).toBe(5);
    for (const n of names) expect(n).toMatch(AOSS_NAME);
  });
});
