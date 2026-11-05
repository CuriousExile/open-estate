import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  AUDIT_LOG_BY_AGENCY_INDEX,
  AUDIT_LOG_BY_AGENCY_PK_ATTRIBUTE,
  AUDIT_LOG_BY_AGENCY_SK_ATTRIBUTE,
  DEFAULT_METRICS_NAMESPACE,
  DEFAULT_RATE_LIMIT,
  DELETION_BLOCKLIST_KEY_ATTRIBUTE,
  DELETION_REQUESTS_BY_STATUS_INDEX,
  DELETION_REQUESTS_BY_STATUS_PK_ATTRIBUTE,
  DELETION_REQUESTS_BY_STATUS_SK_ATTRIBUTE,
  DELETION_REQUESTS_KEY_ATTRIBUTE,
  LISTINGS_BY_AGENCY_INDEX,
  LISTINGS_BY_AGENCY_PK_ATTRIBUTE,
  LISTINGS_BY_AGENCY_SK_ATTRIBUTE,
  LISTINGS_BY_ID_INDEX,
  LISTINGS_BY_ID_PK_ATTRIBUTE,
  LISTINGS_BY_SOURCE_INDEX,
  customIdBlocklistKey,
  MCP_REQUEST_DEADLINE_MS,
  rateLimitSchema,
} from '@open-estate/core';
import { AUDIT_LOG_PARTITION_KEY, AUDIT_LOG_SORT_KEY } from '@open-estate/admin';
import { LISTINGS_ROUTES } from '@open-estate/api';
import { ERROR_CODES, ERROR_HTTP_STATUS, type ErrorCode } from '@open-estate/shared';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import {
  ApiStack,
  GATEWAY_RESPONSES,
  gatewayCorsHeaders,
  LISTINGS_METHODS,
  MCP_METHODS,
  MCP_ROUTE,
  METRICS_NAMESPACE,
  type OpenSearchTarget,
} from '../src/api-stack';
import {
  DEFAULT_CONFIG_DIR,
  DEFAULT_FRONTEND_ASSET_DIR,
  DEFAULT_I18N_CONFIG_FILE,
  resolveEnvironment,
  resolvePlatformSettings,
  WAF_RATE_LIMIT_WINDOW_SECONDS,
} from '../src/config';
import { ConfigDirectoryError, loadConfigDirectory } from '../src/config-files';
import { DataStack, frontendOriginParameterName, ssmParameterNames } from '../src/data-stack';
import {
  FrontendStack,
  frontendRuntimeSources,
  tourProvidersFromConfigFiles,
} from '../src/frontend-stack';
import { ManagementDataStack } from '../src/management-stack';

// Same feature flags as `cdk synth`, so the template matches what gets deployed.
const CDK_CONTEXT = (
  JSON.parse(readFileSync(path.join(__dirname, '../cdk.json'), 'utf8')) as {
    context: Record<string, unknown>;
  }
).context;

/** A fixed target instead of a SearchStack, for the ApiStack alone. */
const OPENSEARCH_TARGET: OpenSearchTarget = {
  endpoint: 'https://search.example.com',
  index: 'listings',
  collectionName: 'open-estate-dev',
  collectionArn: 'arn:aws:aoss:eu-central-1:111111111111:collection/abc',
};

/**
 * Builds both stacks like `app.ts`, with optional context overrides. Lambda bundling is skipped
 * (`aws:cdk:bundling-stacks` = [], the standard CDK switch for tests): esbuild costs ~3 s per synth,
 * and real bundling is exercised by `npm run synth`.
 */
function synth(
  envName: string,
  context: Record<string, unknown> = {},
  openSearch?: OpenSearchTarget,
) {
  const config = resolveEnvironment(envName);
  const app = new App({
    context: { ...CDK_CONTEXT, 'aws:cdk:bundling-stacks': [], ...context },
  });
  const settings = resolvePlatformSettings((key) => app.node.tryGetContext(key));
  const data = new DataStack(app, `${config.stackPrefix}-Data`, { environment: config, settings });
  const managementData = new ManagementDataStack(app, `${config.stackPrefix}-ManagementData`, {
    removalPolicy: config.removalPolicy,
  });
  const api = new ApiStack(app, `${config.stackPrefix}-Api`, {
    tables: {
      listings: data.listingsTable,
      apiKeys: data.apiKeysTable,
      rateLimitCounters: data.rateLimitCountersTable,
      agencies: managementData.agenciesTable,
    },
    config: { configBucket: data.configBucket, parameterNames: data.parameterNames },
    cors: {
      frontendOriginParameter: frontendOriginParameterName(config.envName),
      allowedOrigins: settings.corsAllowedOrigins,
    },
    stageName: config.stageName,
    removalPolicy: config.removalPolicy,
    searchProvider: settings.searchProvider,
    wafRateLimit: settings.wafRateLimit,
    ...(openSearch && { openSearch }),
    observability: settings.observability,
  });
  return {
    data: Template.fromStack(data),
    api: Template.fromStack(api),
    // Cross-stack references as they appear inside the ApiStack template.
    tableNameRef: api.resolve(data.listingsTable.tableName) as unknown,
    tableArnRef: api.resolve(data.listingsTable.tableArn) as unknown,
    apiKeysNameRef: api.resolve(data.apiKeysTable.tableName) as unknown,
    apiKeysArnRef: api.resolve(data.apiKeysTable.tableArn) as unknown,
    countersNameRef: api.resolve(data.rateLimitCountersTable.tableName) as unknown,
    countersArnRef: api.resolve(data.rateLimitCountersTable.tableArn) as unknown,
    agenciesNameRef: api.resolve(managementData.agenciesTable.tableName) as unknown,
    agenciesArnRef: api.resolve(managementData.agenciesTable.tableArn) as unknown,
    bucketNameRef: api.resolve(data.configBucket.bucketName) as unknown,
    bucketArnRef: api.resolve(data.configBucket.bucketArn) as unknown,
  };
}

type Resource = { Properties: Record<string, unknown>; DeletionPolicy?: string };

/** The single resource of `type` whose logical id starts with `prefix`. */
function resource(template: Template, type: string, prefix: string): Resource {
  const matches = Object.entries(template.findResources(type)).filter(([id]) =>
    id.startsWith(prefix),
  );
  expect(matches).toHaveLength(1);
  return matches[0]?.[1] as Resource;
}

/** SSM parameter values by name. */
function parameters(template: Template): Record<string, unknown> {
  return Object.fromEntries(
    Object.values(template.findResources('AWS::SSM::Parameter')).map((r) => {
      const { Name, Value } = (r as { Properties: { Name: string; Value: unknown } }).Properties;
      return [Name, Value];
    }),
  );
}

const dev = synth('dev');
const prod = synth('prod');

describe('DataStack', () => {
  it('defines six on-demand tables', () => {
    dev.data.resourceCountIs('AWS::DynamoDB::GlobalTable', 6);
    for (const table of Object.values(dev.data.findResources('AWS::DynamoDB::GlobalTable'))) {
      expect(table).toMatchObject({ Properties: { BillingMode: 'PAY_PER_REQUEST' } });
    }
  });

  it('defines Listings: PK id, PITR, GSIs byId (sparse gsiPk), bySource, byAgency (Req 2.7, 6.3)', () => {
    expect(resource(dev.data, 'AWS::DynamoDB::GlobalTable', 'Listings').Properties).toMatchObject({
      KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
      AttributeDefinitions: expect.arrayContaining([
        { AttributeName: 'id', AttributeType: 'S' },
        { AttributeName: LISTINGS_BY_ID_PK_ATTRIBUTE, AttributeType: 'S' },
      ]),
      GlobalSecondaryIndexes: [
        {
          IndexName: LISTINGS_BY_ID_INDEX,
          KeySchema: [
            { AttributeName: LISTINGS_BY_ID_PK_ATTRIBUTE, KeyType: 'HASH' },
            { AttributeName: 'id', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
        {
          IndexName: LISTINGS_BY_SOURCE_INDEX,
          KeySchema: [
            { AttributeName: 'source', KeyType: 'HASH' },
            { AttributeName: 'id', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
        {
          IndexName: LISTINGS_BY_AGENCY_INDEX,
          KeySchema: [
            { AttributeName: LISTINGS_BY_AGENCY_PK_ATTRIBUTE, KeyType: 'HASH' },
            { AttributeName: LISTINGS_BY_AGENCY_SK_ATTRIBUTE, KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
      ],
      Replicas: [
        expect.objectContaining({
          PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
        }),
      ],
    });
    expect([
      LISTINGS_BY_ID_INDEX,
      LISTINGS_BY_ID_PK_ATTRIBUTE,
      LISTINGS_BY_SOURCE_INDEX,
      LISTINGS_BY_AGENCY_INDEX,
      LISTINGS_BY_AGENCY_PK_ATTRIBUTE,
      LISTINGS_BY_AGENCY_SK_ATTRIBUTE,
    ]).toEqual(['byId', 'gsiPk', 'bySource', 'byAgency', 'agencyId', 'updatedAt']);
  });

  it('adds at most one new GSI per table, as DynamoDB allows only one GSI creation per update', () => {
    // Listings gained byAgency, AuditLog gained byAgency: one each, deployable in one update.
    const indexNames = (prefix: string) =>
      (
        resource(dev.data, 'AWS::DynamoDB::GlobalTable', prefix).Properties[
          'GlobalSecondaryIndexes'
        ] as { IndexName: string }[]
      ).map((i) => i.IndexName);
    expect(indexNames('Listings')).toEqual(['byId', 'bySource', 'byAgency']);
    expect(indexNames('AuditLog')).toEqual(['byAgency']);
  });

  it('defines DeletionBlocklist: PK listingId (ids and custom# keys), PITR, protected in prod', () => {
    // Custom_Id keys share the string key attribute with listing ids: no schema change (Req 12.14).
    expect(DELETION_BLOCKLIST_KEY_ATTRIBUTE).toBe('listingId');
    expect(customIdBlocklistKey('agency-1', 'ext-7')).toBe('custom#agency-1#ext-7');
    expect(resource(dev.data, 'AWS::DynamoDB::GlobalTable', 'DeletionBlocklist')).toMatchObject({
      DeletionPolicy: 'Delete',
      Properties: {
        KeySchema: [{ AttributeName: DELETION_BLOCKLIST_KEY_ATTRIBUTE, KeyType: 'HASH' }],
        AttributeDefinitions: [
          { AttributeName: DELETION_BLOCKLIST_KEY_ATTRIBUTE, AttributeType: 'S' },
        ],
        Replicas: [
          expect.objectContaining({
            PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
          }),
        ],
      },
    });
    expect(resource(prod.data, 'AWS::DynamoDB::GlobalTable', 'DeletionBlocklist')).toMatchObject({
      DeletionPolicy: 'Retain',
      Properties: { Replicas: [expect.objectContaining({ DeletionProtectionEnabled: true })] },
    });
  });

  it('defines ApiKeys: PK keyId, GSI byHash on keyHash with projection ALL', () => {
    expect(resource(dev.data, 'AWS::DynamoDB::GlobalTable', 'ApiKeys').Properties).toMatchObject({
      KeySchema: [{ AttributeName: 'keyId', KeyType: 'HASH' }],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'byHash',
          KeySchema: [{ AttributeName: 'keyHash', KeyType: 'HASH' }],
          Projection: { ProjectionType: 'ALL' },
        },
      ],
    });
  });

  it('defines DeletionRequests: PK requestId, PITR, GSI byStatus (status, requestedAt) KEYS_ONLY', () => {
    expect(
      resource(dev.data, 'AWS::DynamoDB::GlobalTable', 'DeletionRequests').Properties,
    ).toMatchObject({
      KeySchema: [{ AttributeName: DELETION_REQUESTS_KEY_ATTRIBUTE, KeyType: 'HASH' }],
      GlobalSecondaryIndexes: [
        {
          IndexName: DELETION_REQUESTS_BY_STATUS_INDEX,
          KeySchema: [
            { AttributeName: DELETION_REQUESTS_BY_STATUS_PK_ATTRIBUTE, KeyType: 'HASH' },
            { AttributeName: DELETION_REQUESTS_BY_STATUS_SK_ATTRIBUTE, KeyType: 'RANGE' },
          ],
          // The overdue check reads only the table key from the index.
          Projection: { ProjectionType: 'KEYS_ONLY' },
        },
      ],
      Replicas: [
        expect.objectContaining({
          PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
        }),
      ],
    });
  });

  it('defines AuditLog with the keys DynamoDbAuditLog writes, GSI byAgency, PITR (Req 11.5)', () => {
    expect(resource(dev.data, 'AWS::DynamoDB::GlobalTable', 'AuditLog').Properties).toMatchObject({
      KeySchema: [
        { AttributeName: AUDIT_LOG_PARTITION_KEY, KeyType: 'HASH' },
        { AttributeName: AUDIT_LOG_SORT_KEY, KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: AUDIT_LOG_BY_AGENCY_INDEX,
          KeySchema: [
            { AttributeName: AUDIT_LOG_BY_AGENCY_PK_ATTRIBUTE, KeyType: 'HASH' },
            { AttributeName: AUDIT_LOG_BY_AGENCY_SK_ATTRIBUTE, KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
      ],
      Replicas: [
        expect.objectContaining({
          PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
        }),
      ],
    });
  });

  it('defines RateLimitCounters: PK counterKey, TTL on expiresAt, always disposable', () => {
    for (const { data } of [dev, prod]) {
      const table = resource(data, 'AWS::DynamoDB::GlobalTable', 'RateLimitCounters');
      expect(table).toMatchObject({
        DeletionPolicy: 'Delete',
        Properties: {
          KeySchema: [{ AttributeName: 'counterKey', KeyType: 'HASH' }],
          TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
        },
      });
    }
  });

  it('keeps dev disposable: Delete policy, no deletion protection', () => {
    for (const prefix of ['Listings', 'ApiKeys', 'DeletionRequests', 'AuditLog']) {
      expect(resource(dev.data, 'AWS::DynamoDB::GlobalTable', prefix)).toMatchObject({
        DeletionPolicy: 'Delete',
        Properties: { Replicas: [expect.objectContaining({ DeletionProtectionEnabled: false })] },
      });
    }
  });

  it('protects prod data: Retain policy and deletion protection', () => {
    for (const prefix of ['Listings', 'ApiKeys', 'DeletionRequests', 'AuditLog']) {
      expect(resource(prod.data, 'AWS::DynamoDB::GlobalTable', prefix)).toMatchObject({
        DeletionPolicy: 'Retain',
        Properties: { Replicas: [expect.objectContaining({ DeletionProtectionEnabled: true })] },
      });
    }
  });

  it('makes the config bucket private, encrypted, versioned and TLS-only', () => {
    dev.data.resourceCountIs('AWS::S3::Bucket', 1);
    dev.data.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } },
        ],
      },
      VersioningConfiguration: { Status: 'Enabled' },
    });
    dev.data.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Deny',
            Action: 's3:*',
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          }),
        ]),
      },
    });
  });

  it('empties and deletes the config bucket in dev only', () => {
    dev.data.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Delete' });
    dev.data.resourceCountIs('Custom::S3AutoDeleteObjects', 1);
    prod.data.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Retain' });
    prod.data.resourceCountIs('Custom::S3AutoDeleteObjects', 0);
  });

  it('uploads the config files without pruning other objects', () => {
    dev.data.hasResourceProperties('Custom::CDKBucketDeployment', {
      DestinationBucketName: { Ref: Match.stringLikeRegexp('^ConfigBucket') },
      Prune: false,
    });
  });

  it('creates the SSM parameters with documented defaults (Req 9.3, 17.1)', () => {
    const configBucketRef = { Ref: Match.stringLikeRegexp('^ConfigBucket') };
    expect(parameters(dev.data)).toEqual({
      '/open-estate/dev/default-currency': 'EUR',
      '/open-estate/dev/access-mode': 'open',
      '/open-estate/dev/rate-limit': '{"requests":60,"windowSeconds":60}',
      '/open-estate/dev/config-bucket': expect.anything(),
      '/open-estate/dev/search-provider': 'dynamodb',
    });
    dev.data.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/open-estate/dev/config-bucket',
      Value: configBucketRef,
      Type: 'String',
    });
    expect(Object.keys(parameters(prod.data))).toEqual(Object.values(ssmParameterNames('prod')));
  });

  it('writes the default rate limit in the format SsmAccessConfigSource reads', () => {
    const raw = parameters(dev.data)['/open-estate/dev/rate-limit'];
    expect(rateLimitSchema.parse(JSON.parse(String(raw)))).toEqual(DEFAULT_RATE_LIMIT);
  });

  it('applies context overrides to the SSM parameters', () => {
    const { data } = synth(
      'dev',
      {
        defaultCurrency: 'THB',
        accessMode: 'api-keys',
        rateLimit: '{"requests":100,"windowSeconds":30}',
        searchProvider: 'opensearch',
      },
      OPENSEARCH_TARGET,
    );
    expect(parameters(data)).toMatchObject({
      '/open-estate/dev/default-currency': 'THB',
      '/open-estate/dev/access-mode': 'api-keys',
      '/open-estate/dev/rate-limit': '{"requests":100,"windowSeconds":30}',
      '/open-estate/dev/search-provider': 'opensearch',
    });
  });

  it('outputs the table and bucket names', () => {
    dev.data.hasOutput('ListingsTableName', {
      Value: { Ref: Match.stringLikeRegexp('^Listings') },
    });
    dev.data.hasOutput('ConfigBucketName', {
      Value: { Ref: Match.stringLikeRegexp('^ConfigBucket') },
    });
  });
});

describe('DataStack config validation at synth (Req 15.4)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'open-estate-config-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const write = (name: string, content: unknown) =>
    writeFileSync(
      path.join(dir, name),
      typeof content === 'string' ? content : JSON.stringify(content),
    );

  const mirror = { 'i18n-config.json': DEFAULT_I18N_CONFIG_FILE };

  it('accepts the shipped defaults: taxonomy, empty allowlists and connectors, mirrored i18n', () => {
    const files = loadConfigDirectory(DEFAULT_CONFIG_DIR, mirror);
    const content = (key: string) => JSON.parse(files.find((f) => f.key === key)?.content ?? '');
    expect(files.map((f) => f.key)).toEqual([
      'connectors.json',
      'crawler-allowlist.json',
      'i18n-config.json',
      'pii-allowlist.json',
      'taxonomy.json',
      'tour-providers.json',
    ]);
    // Default-deny: no connector, no crawl target, no PII field, no tour provider.
    expect(content('connectors.json')).toEqual([]);
    expect(content('crawler-allowlist.json')).toEqual({ targets: [] });
    expect(content('pii-allowlist.json')).toEqual({ allowedFields: [] });
    expect(content('tour-providers.json')).toEqual({ providers: [] });
    expect(files.find((f) => f.key === 'i18n-config.json')?.content).toBe(
      readFileSync(DEFAULT_I18N_CONFIG_FILE, 'utf8'),
    );
  });

  it('validates the ingestion config files with their runtime schemas', () => {
    write('taxonomy.json', { groups: [{ code: 'house', types: ['villa'] }] });
    write('pii-allowlist.json', { allowedFields: ['contact.unknown'] });
    write('crawler-allowlist.json', { targets: [{ origin: 'https://a.example/path' }] });
    const connector = { id: 'db', type: 'relational-db', module: 'relational-db', enabled: true };
    write('connectors.json', [
      { ...connector, schedule: 'rate(1 hours)' },
      { ...connector, schedule: 'rate(1 hour)', timeoutSeconds: 901 },
    ]);
    const load = () => loadConfigDirectory(dir, mirror);
    expect(load).toThrow(/pii-allowlist\.json: allowedFields\.0: /);
    expect(load).toThrow(/crawler-allowlist\.json: targets\.0\.origin: /);
    expect(load).toThrow(/connectors\.json: 0\.schedule: must be an EventBridge/);
    expect(load).toThrow(/connectors\.json: 1\.timeoutSeconds: /);
    expect(load).toThrow(/connectors\.json: 1\.id: duplicate connector id/);
  });

  it('validates the mirrored i18n config and rejects a second copy in the config directory', () => {
    write('taxonomy.json', { groups: [{ code: 'house', types: ['villa'] }] });
    write('i18n.json', { defaultLocale: 'fr', enabled: [{ locale: 'de', label: 'Deutsch' }] });
    expect(() =>
      loadConfigDirectory(dir, { 'i18n-config.json': path.join(dir, 'i18n.json') }),
    ).toThrow(/i18n-config\.json: defaultLocale: default locale is not enabled/);
    write('i18n-config.json', '{}');
    expect(() => loadConfigDirectory(dir, mirror)).toThrow(
      /i18n-config\.json: mirrored from .*; remove it from the config directory/,
    );
    expect(() =>
      loadConfigDirectory(dir, { 'i18n-config.json': path.join(dir, 'missing.json') }),
    ).toThrow(/i18n-config\.json: cannot read/);
  });

  it('synthesizes with a valid custom config directory', () => {
    write('taxonomy.json', { groups: [{ code: 'house', types: ['villa'] }] });
    expect(() => synth('dev', { configDir: dir })).not.toThrow();
  });

  it('aborts synth and names every violating code', () => {
    write('taxonomy.json', {
      groups: [
        { code: 'house', types: ['villa', 'house'] },
        { code: 'x'.repeat(65), types: [] },
      ],
    });
    expect(() => synth('dev', { configDir: dir })).toThrow(ConfigDirectoryError);
    let message = '';
    try {
      synth('dev', { configDir: dir });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(`Invalid configuration in ${dir}`);
    expect(message).toContain('taxonomy.json: DUPLICATE_CODE "house"');
    expect(message).toContain(`taxonomy.json: INVALID_CODE_LENGTH "${'x'.repeat(65)}"`);
  });

  it('reports schema errors, invalid JSON, unknown and missing files together', () => {
    write('unknown.json', '{}');
    write('tour-providers.json', { providers: [{ code: 'a', hostnames: ['x.com', 'X.com'] }] });
    expect(() => loadConfigDirectory(dir)).toThrow(/taxonomy\.json: missing/);
    expect(() => loadConfigDirectory(dir)).toThrow(/i18n-config\.json: missing/);
    expect(() => loadConfigDirectory(dir)).toThrow(/unknown\.json: unknown config file/);
    expect(() => loadConfigDirectory(dir)).toThrow(
      /tour-providers\.json: providers\.0\.hostnames\.1: /,
    );

    write('taxonomy.json', '{ not json');
    expect(() => loadConfigDirectory(dir)).toThrow(/taxonomy\.json: invalid JSON/);

    write('taxonomy.json', { groups: [{ code: 1 }] });
    expect(() => loadConfigDirectory(dir)).toThrow(/taxonomy\.json: groups\.0\.code: /);
  });

  it('rejects a config directory that does not exist', () => {
    expect(() => loadConfigDirectory(path.join(dir, 'missing'))).toThrow(/cannot read directory/);
  });
});

describe('ApiStack', () => {
  const functionLogicalId = (prefix: string) =>
    Object.keys(dev.api.findResources('AWS::Lambda::Function')).find((id) =>
      id.startsWith(prefix),
    ) ?? '';
  const listingsFunction = () => resource(dev.api, 'AWS::Lambda::Function', 'ListingsFunction');
  const mcpFunction = () => resource(dev.api, 'AWS::Lambda::Function', 'McpFunction');

  type Statement = { Action: string | string[]; Resource: unknown };
  /** Statements of the policies attached to the role of the function `functionPrefix`. */
  const statements = (template: Template, functionPrefix: string): Statement[] => {
    const role = (
      resource(template, 'AWS::Lambda::Function', functionPrefix).Properties['Role'] as {
        'Fn::GetAtt': [string, string];
      }
    )['Fn::GetAtt'][0];
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
  };

  it('runs the listings Lambda on nodejs22.x/arm64 with a 5 s timeout', () => {
    dev.api.resourceCountIs('AWS::Lambda::Function', 2);
    expect(listingsFunction().Properties).toMatchObject({
      Runtime: 'nodejs22.x',
      Architectures: ['arm64'],
      Timeout: 5,
    });
  });

  it('runs the MCP Lambda on nodejs22.x/arm64 with a timeout above the MCP deadline', () => {
    const { Timeout, MemorySize } = mcpFunction().Properties as {
      Timeout: number;
      MemorySize: number;
    };
    expect(mcpFunction().Properties).toMatchObject({
      Runtime: 'nodejs22.x',
      Architectures: ['arm64'],
      Handler: 'index.handler',
    });
    // The handler's own 10 s abort must still be answered; API Gateway cuts off at 29 s.
    expect(Timeout * 1000).toBeGreaterThan(MCP_REQUEST_DEADLINE_MS);
    expect(Timeout).toBeLessThan(29);
    expect(MemorySize).toBeGreaterThanOrEqual(
      listingsFunction().Properties['MemorySize'] as number,
    );
  });

  it('gives both Lambdas their own log group with one month retention', () => {
    for (const fn of [listingsFunction(), mcpFunction()]) {
      const logGroup = (fn.Properties['LoggingConfig'] as { LogGroup: { Ref: string } }).LogGroup
        .Ref;
      expect(dev.api.findResources('AWS::Logs::LogGroup')[logGroup]).toMatchObject({
        Properties: { RetentionInDays: 30 },
        DeletionPolicy: 'Delete',
      });
    }
    expect(Object.keys(dev.api.findResources('AWS::Logs::LogGroup')).sort()).toEqual([
      expect.stringMatching(/^ListingsFunctionLogs/),
      expect.stringMatching(/^McpFunctionLogs/),
    ]);
  });

  it('sets the same metrics namespace on the API and MCP Lambda (Req 11.4, 14.1)', () => {
    expect(METRICS_NAMESPACE).toBe(DEFAULT_METRICS_NAMESPACE);
    for (const fn of [listingsFunction(), mcpFunction()]) {
      expect(fn.Properties).toMatchObject({
        Environment: { Variables: { POWERTOOLS_METRICS_NAMESPACE: METRICS_NAMESPACE } },
      });
    }
  });

  it('emits RequestCount via EMF: no cloudwatch:PutMetricData grant on the API stack (Req 14.1)', () => {
    for (const template of [dev.api, prod.api]) {
      expect(JSON.stringify(template.findResources('AWS::IAM::Policy'))).not.toContain(
        'cloudwatch:',
      );
    }
  });

  it('gives the MCP Lambda the environment and IAM of the listings Lambda without CORS (Req 19.7)', () => {
    for (const template of [dev.api, prod.api]) {
      const env = (prefix: string) =>
        (
          resource(template, 'AWS::Lambda::Function', prefix).Properties['Environment'] as {
            Variables: Record<string, unknown>;
          }
        ).Variables;
      // MCP serves agents, not browsers: only the listings Lambda reads the CORS allowlist.
      const { FRONTEND_ORIGIN_SSM_PARAMETER: frontendOrigin, ...listingsEnv } =
        env('ListingsFunction');
      expect(frontendOrigin).toBe(
        `/open-estate/${template === dev.api ? 'dev' : 'prod'}/frontend-origin`,
      );
      expect(env('McpFunction')).toEqual(listingsEnv);
      const withoutCors = (resources: unknown[]) =>
        resources.filter((r) => !JSON.stringify(r).includes('/frontend-origin'));
      // `minimizePolicies` may order resources differently per policy.
      const normalized = (prefix: string) =>
        statements(template, prefix)
          .map(({ Action, Resource }) =>
            JSON.stringify({
              Action: [Action].flat().sort(),
              Resource: withoutCors([Resource].flat())
                .map((r) => JSON.stringify(r))
                .sort(),
            }),
          )
          .sort();
      expect(normalized('McpFunction')).toEqual(normalized('ListingsFunction'));
      expect(normalized('McpFunction')).toHaveLength(6);
    }
  });

  it('passes tables, config bucket and SSM parameter names to the Lambda (Req 9.3, 11.1)', () => {
    dev.api.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: {
          NODE_OPTIONS: '--enable-source-maps',
          POWERTOOLS_METRICS_NAMESPACE: 'OpenEstate',
          LISTINGS_TABLE_NAME: dev.tableNameRef,
          API_KEYS_TABLE_NAME: dev.apiKeysNameRef,
          RATE_LIMIT_COUNTERS_TABLE_NAME: dev.countersNameRef,
          AGENCIES_TABLE_NAME: dev.agenciesNameRef,
          CONFIG_BUCKET: dev.bucketNameRef,
          DEFAULT_CURRENCY_SSM_PARAMETER: '/open-estate/dev/default-currency',
          SEARCH_PROVIDER_SSM_PARAMETER: '/open-estate/dev/search-provider',
          ACCESS_MODE_SSM_PARAMETER: '/open-estate/dev/access-mode',
          RATE_LIMIT_SSM_PARAMETER: '/open-estate/dev/rate-limit',
        },
      },
    });
  });

  it('passes the OpenSearch target only when configured', () => {
    const { api } = synth('dev', { searchProvider: 'opensearch' }, OPENSEARCH_TARGET);
    api.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          OPENSEARCH_ENDPOINT: 'https://search.example.com',
          OPENSEARCH_INDEX: 'listings',
        }),
      },
    });
    expect(JSON.stringify(dev.api.toJSON())).not.toContain('OPENSEARCH_');
    expect(() => synth('dev', { searchProvider: 'opensearch' })).toThrow(/OpenSearch target/);
  });

  it('grants exactly the read-model calls: Query on byId/byHash/byState, GetItem, UpdateItem, config', () => {
    // `minimizePolicies` sorts resources; compare them order-independently.
    const sorted = (resources: unknown[]) =>
      [...resources].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const actual = statements(dev.api, 'ListingsFunction').map(({ Action, Resource }) => ({
      Action: [Action].flat(),
      Resource: sorted([Resource].flat()),
    }));
    const join = (arn: unknown, suffix: string) => ({ 'Fn::Join': ['', [arn, suffix]] });
    expect(actual).toEqual(
      expect.arrayContaining([
        {
          Action: ['dynamodb:Query'],
          Resource: sorted([
            join(dev.tableArnRef, '/index/byId'),
            join(dev.apiKeysArnRef, '/index/byHash'),
            join(dev.agenciesArnRef, '/index/byState'),
          ]),
        },
        { Action: ['dynamodb:GetItem'], Resource: [dev.tableArnRef] },
        { Action: ['dynamodb:UpdateItem'], Resource: [dev.countersArnRef] },
        {
          Action: ['s3:GetObject'],
          Resource: sorted(
            ['taxonomy.json', 'i18n-config.json', 'tour-providers.json'].map((key) =>
              join(dev.bucketArnRef, `/${key}`),
            ),
          ),
        },
        { Action: ['s3:ListBucket'], Resource: [dev.bucketArnRef] },
      ]),
    );
    expect(actual).toHaveLength(6);

    const ssm = actual.find((s) => s.Action[0] === 'ssm:GetParameters');
    expect(ssm?.Action).toEqual(['ssm:GetParameters']);
    const parameterArns = JSON.stringify(ssm?.Resource);
    // The four read-model values plus the frontend origin of the CORS allowlist.
    for (const suffix of [
      'default-currency',
      'search-provider',
      'access-mode',
      'rate-limit',
      'frontend-origin',
    ]) {
      expect(parameterArns).toContain(`:parameter/open-estate/dev/${suffix}"`);
    }
    expect(ssm?.Resource).toHaveLength(5);
  });

  it('exposes one REST API without binary media types (routes: see "ApiStack contract")', () => {
    dev.api.resourceCountIs('AWS::ApiGateway::RestApi', 1);
    // No binary media types: MCP and API bodies are JSON text.
    expect(
      resource(dev.api, 'AWS::ApiGateway::RestApi', 'SearchApi').Properties,
    ).not.toHaveProperty('BinaryMediaTypes');
  });

  it('lets API Gateway invoke the MCP Lambda only via the /mcp methods of the stage', () => {
    const mcpId = functionLogicalId('McpFunction');
    const permissions = Object.values(dev.api.findResources('AWS::Lambda::Permission'))
      .map((p) => (p as Resource).Properties)
      .filter((p) => (p['FunctionName'] as { 'Fn::GetAtt': string[] })['Fn::GetAtt'][0] === mcpId);
    expect(permissions.every((p) => p['Principal'] === 'apigateway.amazonaws.com')).toBe(true);
    const sourceArns = permissions.map((p) => JSON.stringify(p['SourceArn']));
    for (const method of ['POST', 'GET', 'DELETE']) {
      expect(sourceArns.some((arn) => arn.includes(`/${method}/mcp"`))).toBe(true);
    }
    // Every method gets a stage and a test-invoke permission, nothing else.
    expect(permissions).toHaveLength(6);
  });

  it('takes the WAF rate limit from the context override', () => {
    const { api } = synth('dev', { wafRateLimit: '5000' });
    api.hasResourceProperties('AWS::WAFv2::WebACL', {
      Rules: [
        Match.objectLike({ Statement: { RateBasedStatement: Match.objectLike({ Limit: 5000 }) } }),
      ],
    });
  });

  it('outputs the URL of the stage', () => {
    const [restApiId] = Object.keys(dev.api.findResources('AWS::ApiGateway::RestApi'));
    const [stageId] = Object.keys(dev.api.findResources('AWS::ApiGateway::Stage'));
    dev.api.hasOutput('ApiUrl', {
      Value: {
        'Fn::Join': ['', Match.arrayWith([{ Ref: restApiId }, { Ref: stageId }])],
      },
    });
  });
});

describe('ApiStack CORS (frontend origin via SSM, context origins)', () => {
  const lambdaEnv = (template: Template, prefix: string) =>
    (
      resource(template, 'AWS::Lambda::Function', prefix).Properties['Environment'] as {
        Variables: Record<string, unknown>;
      }
    ).Variables;
  const gatewayHeaders = (template: Template) =>
    Object.values(template.findResources('AWS::ApiGateway::GatewayResponse')).map(
      (r) => (r as Resource).Properties['ResponseParameters'] as Record<string, string>,
    );

  it('reads the frontend origin by SSM name and passes no context origins by default', () => {
    for (const [name, t] of [
      ['dev', dev],
      ['prod', prod],
    ] as const) {
      expect(lambdaEnv(t.api, 'ListingsFunction')).toMatchObject({
        FRONTEND_ORIGIN_SSM_PARAMETER: `/open-estate/${name}/frontend-origin`,
      });
      expect(lambdaEnv(t.api, 'ListingsFunction')).not.toHaveProperty('CORS_ALLOWED_ORIGINS');
      // No ACAO on gateway responses: no single origin known at synth.
      for (const headers of gatewayHeaders(t.api)) {
        expect(Object.keys(headers).join()).not.toMatch(/Access-Control|Vary/);
      }
    }
  });

  it('passes normalized context origins to the listings Lambda only', () => {
    const { api } = synth('dev', {
      corsAllowedOrigins: 'https://Estate.Example.com,http://localhost:4200',
    });
    expect(lambdaEnv(api, 'ListingsFunction')).toMatchObject({
      CORS_ALLOWED_ORIGINS: 'https://estate.example.com,http://localhost:4200',
    });
    expect(lambdaEnv(api, 'McpFunction')).not.toHaveProperty('CORS_ALLOWED_ORIGINS');
    // Two origins: a static template cannot choose, so gateway responses stay without ACAO.
    for (const headers of gatewayHeaders(api)) {
      expect(headers).not.toHaveProperty('gatewayresponse.header.Access-Control-Allow-Origin');
    }
  });

  const wafCustomResponse = (template: Template) =>
    (
      Object.values(template.findResources('AWS::WAFv2::WebACL'))[0] as {
        Properties: { Rules: { Action: { Block: { CustomResponse: Record<string, unknown> } } }[] };
      }
    ).Properties.Rules[0]?.Action.Block.CustomResponse;

  it('sets a single context origin as literal ACAO on every gateway and the WAF 429 response', () => {
    const { api } = synth('prod', { corsAllowedOrigins: 'https://estate.example.com' });
    expect(wafCustomResponse(api)?.['ResponseHeaders']).toEqual([
      { Name: 'Access-Control-Allow-Origin', Value: 'https://estate.example.com' },
      { Name: 'Access-Control-Expose-Headers', Value: 'Retry-After' },
      { Name: 'Vary', Value: 'Origin' },
    ]);
    expect(wafCustomResponse(dev.api)).not.toHaveProperty('ResponseHeaders');
    const headers = gatewayHeaders(api);
    expect(headers).toHaveLength(GATEWAY_RESPONSES.length);
    for (const h of headers) {
      expect(h).toMatchObject({
        'gatewayresponse.header.Access-Control-Allow-Origin': "'https://estate.example.com'",
        'gatewayresponse.header.Access-Control-Expose-Headers': "'Retry-After'",
        'gatewayresponse.header.Vary': "'Origin'",
        'gatewayresponse.header.Cache-Control': "'no-store'",
      });
    }
  });

  it('never echoes the request Origin and never allows "*" (gatewayCorsHeaders)', () => {
    expect(gatewayCorsHeaders([])).toEqual({});
    expect(gatewayCorsHeaders(['https://a.example', 'https://b.example'])).toEqual({});
    expect(Object.values(gatewayCorsHeaders(['https://a.example'])).join()).not.toMatch(
      /method\.request|\*/,
    );
  });
});

describe('CDK app wiring: no cycle between ApiStack and FrontendStack', () => {
  let assetDir: string;
  beforeAll(() => {
    assetDir = mkdtempSync(path.join(tmpdir(), 'open-estate-app-'));
    writeFileSync(path.join(assetDir, 'index.html'), '<!doctype html>');
  });
  afterAll(() => rmSync(assetDir, { recursive: true, force: true }));

  /** Data, Api and Frontend wired exactly like `app.ts`, synthesized to a cloud assembly. */
  function synthApp(envName: string) {
    const config = resolveEnvironment(envName);
    const app = new App({
      context: { ...CDK_CONTEXT, 'aws:cdk:bundling-stacks': [], frontendAssetDir: assetDir },
    });
    const settings = resolvePlatformSettings((key) => app.node.tryGetContext(key));
    const frontendOriginParameter = frontendOriginParameterName(config.envName);
    const data = new DataStack(app, `${config.stackPrefix}-Data`, {
      environment: config,
      settings,
    });
    const managementData = new ManagementDataStack(app, `${config.stackPrefix}-ManagementData`, {
      removalPolicy: config.removalPolicy,
    });
    const api = new ApiStack(app, `${config.stackPrefix}-Api`, {
      tables: {
        listings: data.listingsTable,
        apiKeys: data.apiKeysTable,
        rateLimitCounters: data.rateLimitCountersTable,
        agencies: managementData.agenciesTable,
      },
      config: { configBucket: data.configBucket, parameterNames: data.parameterNames },
      cors: { frontendOriginParameter, allowedOrigins: settings.corsAllowedOrigins },
      stageName: config.stageName,
      removalPolicy: config.removalPolicy,
      searchProvider: settings.searchProvider,
      wafRateLimit: settings.wafRateLimit,
      observability: settings.observability,
    });
    const frontend = new FrontendStack(app, `${config.stackPrefix}-Frontend`, {
      assetDir: settings.frontendAssetDir,
      runtimeSources: frontendRuntimeSources(settings.i18nConfigFile),
      apiUrl: api.api.url,
      tourProviders: tourProvidersFromConfigFiles(data.configFiles),
      frontendOriginParameter,
      removalPolicy: config.removalPolicy,
    });
    const assembly = app.synth();
    return { api, frontend, assembly, frontendOriginParameter };
  }

  it.each(['dev', 'prod'])('synthesizes %s: Frontend depends on Api, never the reverse', (env) => {
    const { api, frontend, assembly, frontendOriginParameter } = synthApp(env);
    expect(frontend.dependencies.map((s) => s.stackName)).toContain(api.stackName);
    expect(api.dependencies.map((s) => s.stackName)).not.toContain(frontend.stackName);
    // The API template references nothing of the FrontendStack, only the parameter name.
    const apiTemplate = JSON.stringify(assembly.getStackByName(api.stackName).template);
    expect(apiTemplate).not.toContain(frontend.stackName);
    expect(apiTemplate).toContain(frontendOriginParameter);

    // The FrontendStack owns the parameter and writes https://<distribution domain>.
    const parameter = Template.fromStack(frontend).findResources('AWS::SSM::Parameter');
    expect(Object.values(parameter).map((r) => (r as Resource).Properties)).toEqual([
      expect.objectContaining({
        Name: frontendOriginParameter,
        Type: 'String',
        Value: {
          'Fn::Join': [
            '',
            ['https://', { 'Fn::GetAtt': [expect.stringMatching(/^Distribution/), 'DomainName'] }],
          ],
        },
      }),
    ]);
    // Not part of the DataStack's parameter set: one owner per resource.
    expect(Object.values(ssmParameterNames(env))).not.toContain(frontendOriginParameter);
  });
});

describe.each([
  ['dev', dev],
  ['prod', prod],
])('ApiStack contract (%s): routes, gateway responses, WAF (Req 3.4, 9.1, 9.2)', (stage, t) => {
  const props = (template: Template, type: string) =>
    Object.entries(template.findResources(type)).map(
      ([id, r]) => [id, (r as Resource).Properties] as const,
    );
  const [[restApiId] = ['']] = props(t.api, 'AWS::ApiGateway::RestApi');
  const [[stageId] = ['']] = props(t.api, 'AWS::ApiGateway::Stage');
  const functionId = (prefix: string) =>
    props(t.api, 'AWS::Lambda::Function').find(([id]) => id.startsWith(prefix))?.[0];

  /** Resource path (`/listings/{id}`) of a `ResourceId`/`ParentId` reference. */
  const resources = new Map(props(t.api, 'AWS::ApiGateway::Resource'));
  const pathOf = (ref: unknown): string => {
    const id = (ref as { Ref?: string }).Ref;
    if (id === undefined) {
      expect(ref).toEqual({ 'Fn::GetAtt': [restApiId, 'RootResourceId'] });
      return '';
    }
    const r = resources.get(id);
    return `${pathOf(r?.['ParentId'])}/${String(r?.['PathPart'])}`;
  };
  const methods = props(t.api, 'AWS::ApiGateway::Method').map(([, m]) => m);
  const route = (m: Record<string, unknown>) =>
    `${String(m['HttpMethod'])} ${pathOf(m['ResourceId'])}`;

  it('routes the read routes as GET/OPTIONS (preflight) and /mcp as POST/GET/DELETE, no ANY', () => {
    const expected = [
      ...Object.values(LISTINGS_ROUTES).flatMap((path) =>
        LISTINGS_METHODS.map((method) => `${method} ${path}`),
      ),
      ...MCP_METHODS.map((method) => `${method} ${MCP_ROUTE}`),
    ];
    // Each route once; no catch-all, no method on the root resource, no preflight on /mcp.
    expect(methods.map(route).sort()).toEqual(expected.sort());
    for (const method of methods) {
      const target =
        pathOf(method['ResourceId']) === MCP_ROUTE ? 'McpFunction' : 'ListingsFunction';
      expect(method['Integration']).toMatchObject({
        Type: 'AWS_PROXY',
        IntegrationHttpMethod: 'POST',
        Uri: {
          'Fn::Join': ['', expect.arrayContaining([{ 'Fn::GetAtt': [functionId(target), 'Arn'] }])],
        },
      });
    }
  });

  it('does not validate requests at the gateway: Lambda Zod schema is the only source (Req 3.4)', () => {
    t.api.resourceCountIs('AWS::ApiGateway::RequestValidator', 0);
    t.api.resourceCountIs('AWS::ApiGateway::Model', 0);
    for (const method of methods) {
      expect(method).not.toHaveProperty('RequestValidatorId');
      expect(method).not.toHaveProperty('RequestModels');
      expect(method).not.toHaveProperty('RequestParameters');
      expect(method).toMatchObject({ AuthorizationType: 'NONE' });
    }
  });

  // API Gateway defaults of the types that keep their status (no `statusCode` in the table).
  const DEFAULT_STATUS: Readonly<Record<string, number>> = {
    ACCESS_DENIED: 403,
    INVALID_SIGNATURE: 403,
    EXPIRED_TOKEN: 403,
    WAF_FILTERED: 403,
    THROTTLED: 429,
  };

  it('renders every gateway response as no-store ErrorResponse with a catalog code', () => {
    const rendered = new Map(
      props(t.api, 'AWS::ApiGateway::GatewayResponse').map(([, r]) => [r['ResponseType'], r]),
    );
    expect([...rendered.keys()].sort()).toEqual(
      GATEWAY_RESPONSES.map((g) => g.type.responseType).sort(),
    );
    for (const { type, statusCode, code, message, retryAfterSeconds } of GATEWAY_RESPONSES) {
      const r = rendered.get(type.responseType);
      expect(r?.['RestApiId']).toEqual({ Ref: restApiId });
      expect(r?.['StatusCode']).toBe(statusCode === undefined ? undefined : String(statusCode));
      expect(r?.['ResponseParameters']).toEqual({
        'gatewayresponse.header.Cache-Control': "'no-store'",
        ...(retryAfterSeconds !== undefined && {
          'gatewayresponse.header.Retry-After': `'${retryAfterSeconds}'`,
        }),
      });
      const templates = r?.['ResponseTemplates'] as Record<string, string>;
      expect(Object.keys(templates)).toEqual(['application/json']);
      expect(JSON.parse(templates['application/json'] ?? '')).toEqual({
        errors: [{ code, message }],
        ...(retryAfterSeconds !== undefined && { retryAfterSeconds }),
      });
      expect(ERROR_CODES).toContain(code);
      // The effective status matches the catalog, except for the pass-through defaults.
      const status = statusCode ?? DEFAULT_STATUS[type.responseType];
      if (status !== undefined) {
        expect(status).toBe(ERROR_HTTP_STATUS[code as Exclude<ErrorCode, 'UNKNOWN_TOOL'>]);
      }
    }
    // DEFAULT_4XX/5XX must not pin a status: it would override every other 4xx/5xx.
    expect(rendered.get('DEFAULT_4XX')).not.toHaveProperty('StatusCode');
    expect(rendered.get('DEFAULT_5XX')).not.toHaveProperty('StatusCode');
    expect(
      GATEWAY_RESPONSES.filter((g) => g.retryAfterSeconds !== undefined).map(
        (g) => g.type.responseType,
      ),
    ).toEqual(['THROTTLED']);
  });

  it('attaches a regional WAF WebACL with the per-IP rate rule from the settings to the stage', () => {
    const settings = resolvePlatformSettings((key) => CDK_CONTEXT[key]);
    const [[webAclId, webAcl] = ['', {}]] = props(t.api, 'AWS::WAFv2::WebACL');
    expect(webAcl).toMatchObject({
      Scope: 'REGIONAL',
      DefaultAction: { Allow: {} },
      Rules: [
        {
          Name: 'ip-rate-limit',
          Statement: {
            RateBasedStatement: {
              AggregateKeyType: 'IP',
              Limit: settings.wafRateLimit,
              EvaluationWindowSec: WAF_RATE_LIMIT_WINDOW_SECONDS,
            },
          },
          Action: {
            Block: { CustomResponse: { ResponseCode: 429, CustomResponseBodyKey: 'rateLimited' } },
          },
        },
      ],
    });
    expect(webAcl['Rules']).toHaveLength(1);
    const body = (webAcl['CustomResponseBodies'] as Record<string, Record<string, string>>)[
      'rateLimited'
    ];
    expect(body?.['ContentType']).toBe('APPLICATION_JSON');
    expect(JSON.parse(body?.['Content'] ?? '')).toEqual({
      errors: [{ code: 'RATE_LIMITED', message: expect.any(String) }],
    });

    const associations = props(t.api, 'AWS::WAFv2::WebACLAssociation').map(([, a]) => a);
    expect(associations).toEqual([
      {
        WebACLArn: { 'Fn::GetAtt': [webAclId, 'Arn'] },
        ResourceArn: {
          'Fn::Join': [
            '',
            expect.arrayContaining([{ Ref: restApiId }, '/stages/', { Ref: stageId }]),
          ],
        },
      },
    ]);
  });

  it('deploys a regional endpoint with stage-wide throttling', () => {
    t.api.hasResourceProperties('AWS::ApiGateway::RestApi', {
      EndpointConfiguration: { Types: ['REGIONAL'] },
    });
    t.api.resourceCountIs('AWS::ApiGateway::Stage', 1);
    t.api.hasResourceProperties('AWS::ApiGateway::Stage', {
      StageName: stage,
      MethodSettings: [
        Match.objectLike({
          HttpMethod: '*',
          ResourcePath: '/*',
          ThrottlingRateLimit: 100,
          ThrottlingBurstLimit: 200,
        }),
      ],
    });
  });
});

describe('resolveEnvironment', () => {
  it.each([
    ['dev', 'OpenEstate-dev'],
    ['prod', 'OpenEstate-prod'],
  ])('derives names for %s', (envName, stackPrefix) => {
    expect(resolveEnvironment(envName)).toMatchObject({ envName, stackPrefix, stageName: envName });
  });

  it('defaults to dev', () => {
    expect(resolveEnvironment(undefined).envName).toBe('dev');
  });

  it.each(['', 'Prod', '1dev', 'dev_1', 'a'.repeat(17), 42])('rejects %j', (envName) => {
    expect(() => resolveEnvironment(envName)).toThrow(/Invalid context value "env"/);
  });
});

describe('resolvePlatformSettings', () => {
  const from = (context: Record<string, unknown>) => (key: string) => context[key];

  it('defaults to EUR, open, 60/60, dynamodb and the shipped config', () => {
    expect(resolvePlatformSettings(from({}))).toEqual({
      defaultCurrency: 'EUR',
      accessMode: 'open',
      rateLimit: { requests: 60, windowSeconds: 60 },
      searchProvider: 'dynamodb',
      configDir: DEFAULT_CONFIG_DIR,
      i18nConfigFile: DEFAULT_I18N_CONFIG_FILE,
      wafRateLimit: 2_000,
      frontendAssetDir: DEFAULT_FRONTEND_ASSET_DIR,
      frontendPriceClass: 'PriceClass_100',
      corsAllowedOrigins: [],
      observability: { logLevel: 'INFO', metricsDisabled: false },
    });
  });

  it('accepts a rate limit object from cdk.json and resolves configDir against the cwd', () => {
    expect(
      resolvePlatformSettings(
        from({ rateLimit: { requests: 10_000, windowSeconds: 3_600 }, configDir: 'cfg' }),
      ),
    ).toMatchObject({
      rateLimit: { requests: 10_000, windowSeconds: 3_600 },
      configDir: path.resolve('cfg'),
    });
  });

  it('defaults observability to INFO with metrics enabled', () => {
    const settings = resolvePlatformSettings(from({}));
    expect(settings.observability).toEqual({ logLevel: 'INFO', metricsDisabled: false });
  });

  it('reads logLevel and metricsDisabled from context', () => {
    const settings = resolvePlatformSettings(from({ logLevel: 'WARN', metricsDisabled: 'true' }));
    expect(settings.observability).toEqual({ logLevel: 'WARN', metricsDisabled: true });
  });

  it('sets POWERTOOLS_LOG_LEVEL on the runtime Lambdas, default INFO without a disable flag', () => {
    const { api } = synth('dev');
    api.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: Match.objectLike({ POWERTOOLS_LOG_LEVEL: 'INFO' }) },
    });
    for (const fn of Object.values(api.findResources('AWS::Lambda::Function'))) {
      const vars = (fn.Properties as { Environment?: { Variables?: Record<string, unknown> } })
        .Environment?.Variables;
      if (vars && 'POWERTOOLS_LOG_LEVEL' in vars) {
        // No metrics disable flag while metrics stay on (its mere presence suppresses EMF).
        expect(vars).not.toHaveProperty('POWERTOOLS_METRICS_DISABLED');
      }
    }
  });

  it('lowers the log level and disables metrics on the runtime Lambdas from context', () => {
    const { api } = synth('dev', { logLevel: 'SILENT', metricsDisabled: 'true' });
    api.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({
          POWERTOOLS_LOG_LEVEL: 'SILENT',
          POWERTOOLS_METRICS_DISABLED: 'true',
        }),
      },
    });
  });

  it('reports every invalid value at once', () => {
    expect(() =>
      resolvePlatformSettings(
        from({
          defaultCurrency: 'XYZ',
          accessMode: 'closed',
          rateLimit: '{"requests":0,"windowSeconds":60}',
          searchProvider: 'elastic',
          configDir: ' ',
          i18nConfigFile: '',
          wafRateLimit: '9',
          frontendAssetDir: '',
          frontendPriceClass: 'PriceClass_50',
          corsAllowedOrigins: '*',
          logLevel: 'VERBOSE',
          metricsDisabled: 'maybe',
        }),
      ),
    ).toThrow(
      /"defaultCurrency".*\n.*"accessMode".*\n.*"rateLimit".*\n.*"searchProvider".*\n.*"configDir".*\n.*"i18nConfigFile".*\n.*"wafRateLimit".*\n.*"frontendAssetDir".*\n.*"frontendPriceClass".*\n.*"corsAllowedOrigins".*\n.*"logLevel".*\n.*"metricsDisabled"/,
    );
  });

  it.each([
    [
      'a comma-separated list',
      'https://Estate.Example.com, http://localhost:4200',
      ['https://estate.example.com', 'http://localhost:4200'],
    ],
    [
      'a JSON array from cdk.json',
      ['https://estate.example.com:443'],
      ['https://estate.example.com'],
    ],
    ['an empty value', '', []],
  ])('accepts CORS origins as %s, normalized', (_, corsAllowedOrigins, expected) => {
    expect(resolvePlatformSettings(from({ corsAllowedOrigins })).corsAllowedOrigins).toEqual(
      expected,
    );
  });

  it.each([
    '*',
    'https://estate.example.com/',
    'https://estate.example.com/app',
    'ftp://x.org',
    'null',
  ])('rejects CORS origin %j', (corsAllowedOrigins) => {
    expect(() => resolvePlatformSettings(from({ corsAllowedOrigins }))).toThrow(
      /"corsAllowedOrigins"/,
    );
  });

  it.each(['eur', 'EURO', 'XYZ'])('rejects currency %j', (defaultCurrency) => {
    expect(() => resolvePlatformSettings(from({ defaultCurrency }))).toThrow(/ISO 4217/);
  });

  it.each(['{"requests":60,"windowSeconds":3601}', '{"requests":1.5,"windowSeconds":60}', '60/60'])(
    'rejects rate limit %j',
    (rateLimit) => {
      expect(() => resolvePlatformSettings(from({ rateLimit }))).toThrow(/"rateLimit"/);
    },
  );
});
