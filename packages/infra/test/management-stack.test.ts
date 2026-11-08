import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  AGENCIES_BY_STATE_INDEX,
  AGENCIES_KEY_ATTRIBUTE,
  CONNECTOR_RUNS_BY_AGENCY_INDEX,
  CONNECTOR_RUNS_PK_ATTRIBUTE,
  CONNECTOR_RUNS_SK_ATTRIBUTE,
  CONNECTOR_RUNS_TTL_ATTRIBUTE,
  DEFAULT_RATE_LIMIT,
  DUPLICATE_INDEX_BLOCK_ATTRIBUTE,
  DUPLICATE_INDEX_BLOCK_SK_ATTRIBUTE,
  DUPLICATE_INDEX_BY_BLOCK,
  DUPLICATE_INDEX_PK,
  DUPLICATE_INDEX_SK,
  DUPLICATE_REPORTS_BY_STATE,
  DUPLICATE_REPORTS_PK,
  DUPLICATE_REPORTS_STATE_ATTRIBUTE,
  DUPLICATE_REPORTS_STATE_SK_ATTRIBUTE,
  IDEMPOTENCY_KEYS_BY_LISTING,
  IDEMPOTENCY_KEYS_LISTING_ATTRIBUTE,
  IDEMPOTENCY_KEYS_PK,
  IDEMPOTENCY_KEYS_TTL_ATTRIBUTE,
  LISTING_KEYS_PK_ATTRIBUTE,
  LISTING_VERSIONS_PK_ATTRIBUTE,
  LISTING_VERSIONS_SK_ATTRIBUTE,
  MACHINE_ACCESS_BY_AGENCY_INDEX,
  MACHINE_ACCESS_KEY_ATTRIBUTE,
  MEMBERSHIPS_BY_AGENCY_INDEX,
  MEMBERSHIPS_KEY_ATTRIBUTE,
  METRIC_COUNTERS_PK_ATTRIBUTE,
  METRIC_COUNTERS_SK_ATTRIBUTE,
  METRIC_COUNTERS_TTL_ATTRIBUTE,
  PLATFORM_COUNTERS_KEY_ATTRIBUTE,
  RUN_REJECTIONS_PK_ATTRIBUTE,
  RUN_REJECTIONS_SK_ATTRIBUTE,
  USAGE_AGGREGATOR_ENV,
  USAGE_LOG_FILTER_PATTERN,
} from '@open-estate/core';
import { DUPLICATE_SWEEP_ENV, DUPLICATES_ENV, MANAGEMENT_ENV } from '@open-estate/management';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { DEFAULT_CONFIG_DIR, ENV_CONTEXT_KEY } from '../src/config';
import { IDENTITY_CONTEXT_KEYS } from '../src/identity-stack';
import {
  MANAGEMENT_CONFIG_FILES,
  MANAGEMENT_ROUTE_ENV,
  managementRateLimitParameterName,
} from '../src/management-stack';
import { buildPlatform, type PlatformStacks } from '../src/platform';
// Not exported by the package index; compared with the mirror in `management-stack.ts`.
import { IDENTITY_ENV } from '../../management/src/routes/identity/services';
import {
  LISTING_CONFIG_FILES,
  LISTING_ROUTES_ENV,
} from '../../management/src/routes/listings/services';
import { MONITORING_ENV } from '../../management/src/routes/monitoring/wiring';
import { PLATFORM_ENV } from '../../management/src/routes/platform/platform-env';

// Task 12.2 / 12.4: ManagementDataStack and ManagementStack in the real app wiring
// (`buildPlatform`), so cross-stack references and the absence of cycles are covered too.

const CDK_CONTEXT = (
  JSON.parse(readFileSync(path.join(__dirname, '../cdk.json'), 'utf8')) as {
    context: Record<string, unknown>;
  }
).context;

const CONNECTOR = {
  id: 'partner-db',
  type: 'relational-db',
  module: 'relational-db',
  enabled: true,
  schedule: 'rate(1 hour)',
  timeoutSeconds: 600,
  settings: {},
};

interface Synthesized {
  stacks: PlatformStacks;
  templates: Record<string, Template>;
}

/** Whole app with one connector in a temporary config/asset dir; bundling skipped. */
function synthPlatform(context: Record<string, unknown> = {}): Synthesized {
  const dir = mkdtempSync(path.join(tmpdir(), 'open-estate-management-'));
  try {
    const configDir = path.join(dir, 'config');
    cpSync(DEFAULT_CONFIG_DIR, configDir, { recursive: true });
    writeFileSync(path.join(configDir, 'connectors.json'), JSON.stringify([CONNECTOR]));
    const assetDir = path.join(dir, 'assets');
    mkdirSync(assetDir);
    writeFileSync(path.join(assetDir, 'index.html'), '<!doctype html>');
    const app = new App({
      outdir: path.join(dir, 'cdk.out'),
      context: {
        ...CDK_CONTEXT,
        'aws:cdk:bundling-stacks': [],
        [ENV_CONTEXT_KEY]: 'dev',
        configDir,
        frontendAssetDir: assetDir,
        ...context,
      },
    });
    const stacks = buildPlatform(app);
    app.synth(); // fails on a dependency cycle
    const templates = Object.fromEntries(
      Object.entries(stacks).map(([name, stack]) => [name, Template.fromStack(stack)]),
    );
    return { stacks, templates };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

type Resource = { Type: string; Properties: Record<string, unknown> };
type Statement = { Action: string | string[]; Resource: unknown; Condition?: unknown };

function only(template: Template, type: string, prefix: string): Resource {
  const matches = Object.entries(template.findResources(type)).filter(([id]) =>
    id.startsWith(prefix),
  );
  expect(matches).toHaveLength(1);
  return matches[0]?.[1] as Resource;
}

/**
 * Statements of the policies attached to the role of the function `prefix`: inline policies and
 * the managed policies CDK splits off when the inline policy would exceed the IAM size limit.
 */
function roleStatements(template: Template, prefix: string): Statement[] {
  const role = (
    only(template, 'AWS::Lambda::Function', prefix).Properties['Role'] as {
      'Fn::GetAtt': [string];
    }
  )['Fn::GetAtt'][0];
  return [
    ...Object.values(template.findResources('AWS::IAM::Policy')),
    ...Object.values(template.findResources('AWS::IAM::ManagedPolicy')).filter(
      (p) => (p as { Properties: { Roles?: unknown } }).Properties.Roles !== undefined,
    ),
  ]
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

const actions = (s: Statement) => [s.Action].flat();

/** Actions granted on resources whose JSON mentions `part` (logical id or output name). */
function actionsOn(statements: Statement[], part: string): string[] {
  return [
    ...new Set(
      statements.filter((s) => JSON.stringify(s.Resource).includes(part)).flatMap(actions),
    ),
  ].sort();
}

function variables(template: Template, prefix: string): Record<string, unknown> {
  return (
    only(template, 'AWS::Lambda::Function', prefix).Properties['Environment'] as {
      Variables: Record<string, unknown>;
    }
  ).Variables;
}

const app = synthPlatform();
const t = app.templates;

function templateOf(synthesized: Synthesized, name: keyof PlatformStacks): Template {
  const template = synthesized.templates[name];
  if (template === undefined) throw new Error(`stack ${name} missing`);
  return template;
}
const md = templateOf(app, 'managementData');

describe('ManagementDataStack (task 12.2)', () => {
  const table = (prefix: string) => only(md, 'AWS::DynamoDB::GlobalTable', prefix);

  it('defines the twelve on-demand tables with PITR', () => {
    md.resourceCountIs('AWS::DynamoDB::GlobalTable', 12);
    for (const resource of Object.values(md.findResources('AWS::DynamoDB::GlobalTable'))) {
      expect(resource).toMatchObject({
        Properties: {
          BillingMode: 'PAY_PER_REQUEST',
          Replicas: [
            expect.objectContaining({
              PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
            }),
          ],
        },
      });
    }
  });

  it.each([
    ['ListingVersions', LISTING_VERSIONS_PK_ATTRIBUTE, [LISTING_VERSIONS_SK_ATTRIBUTE, 'N']],
    ['ListingKeys', LISTING_KEYS_PK_ATTRIBUTE, undefined],
    ['Agencies', AGENCIES_KEY_ATTRIBUTE, undefined],
    ['Memberships', MEMBERSHIPS_KEY_ATTRIBUTE, undefined],
    ['PlatformCounters', PLATFORM_COUNTERS_KEY_ATTRIBUTE, undefined],
    ['MachineAccess', MACHINE_ACCESS_KEY_ATTRIBUTE, undefined],
    ['MetricCounters', METRIC_COUNTERS_PK_ATTRIBUTE, [METRIC_COUNTERS_SK_ATTRIBUTE, 'S']],
    ['ConnectorRuns', CONNECTOR_RUNS_PK_ATTRIBUTE, [CONNECTOR_RUNS_SK_ATTRIBUTE, 'S']],
    ['RunRejections', RUN_REJECTIONS_PK_ATTRIBUTE, [RUN_REJECTIONS_SK_ATTRIBUTE, 'N']],
    ['DuplicateIndex', DUPLICATE_INDEX_PK, [DUPLICATE_INDEX_SK, 'S']],
    ['IdempotencyKeys', IDEMPOTENCY_KEYS_PK, undefined],
    ['DuplicateReports', DUPLICATE_REPORTS_PK, undefined],
  ] as const)('%s uses the key schema of the core store', (name, pk, sk) => {
    const props = table(name).Properties;
    expect(props['KeySchema']).toEqual([
      { AttributeName: pk, KeyType: 'HASH' },
      ...(sk === undefined ? [] : [{ AttributeName: sk[0], KeyType: 'RANGE' }]),
    ]);
    expect(props['AttributeDefinitions']).toEqual(
      expect.arrayContaining([
        { AttributeName: pk, AttributeType: 'S' },
        ...(sk === undefined ? [] : [{ AttributeName: sk[0], AttributeType: sk[1] }]),
      ]),
    );
  });

  it('defines the GSIs the stores query', () => {
    const indexes = (name: string) =>
      (
        table(name).Properties['GlobalSecondaryIndexes'] as { IndexName: string }[] | undefined
      )?.map((i) => i.IndexName) ?? [];
    expect(indexes('Agencies')).toEqual([AGENCIES_BY_STATE_INDEX]);
    expect(indexes('Memberships')).toEqual([MEMBERSHIPS_BY_AGENCY_INDEX]);
    expect(indexes('MachineAccess')).toEqual([MACHINE_ACCESS_BY_AGENCY_INDEX]);
    expect(indexes('ConnectorRuns')).toEqual([CONNECTOR_RUNS_BY_AGENCY_INDEX]);
    expect(indexes('ListingVersions')).toEqual([]);
    expect(indexes('DuplicateIndex')).toEqual([DUPLICATE_INDEX_BY_BLOCK]);
    expect(indexes('IdempotencyKeys')).toEqual([IDEMPOTENCY_KEYS_BY_LISTING]);
    expect(indexes('DuplicateReports')).toEqual([DUPLICATE_REPORTS_BY_STATE]);
  });

  it('projects only keys into the duplicate GSIs (duplicate-detection task 11.5)', () => {
    const gsi = (name: string) =>
      (table(name).Properties['GlobalSecondaryIndexes'] as Record<string, unknown>[])[0];
    expect(gsi('DuplicateIndex')).toMatchObject({
      IndexName: DUPLICATE_INDEX_BY_BLOCK,
      KeySchema: [
        { AttributeName: DUPLICATE_INDEX_BLOCK_ATTRIBUTE, KeyType: 'HASH' },
        { AttributeName: DUPLICATE_INDEX_BLOCK_SK_ATTRIBUTE, KeyType: 'RANGE' },
      ],
      Projection: { ProjectionType: 'KEYS_ONLY' },
    });
    expect(gsi('IdempotencyKeys')).toMatchObject({
      IndexName: IDEMPOTENCY_KEYS_BY_LISTING,
      KeySchema: [{ AttributeName: IDEMPOTENCY_KEYS_LISTING_ATTRIBUTE, KeyType: 'HASH' }],
      Projection: { ProjectionType: 'KEYS_ONLY' },
    });
    // The Treffer list shows every attribute, by descending score.
    expect(gsi('DuplicateReports')).toMatchObject({
      IndexName: DUPLICATE_REPORTS_BY_STATE,
      KeySchema: [
        { AttributeName: DUPLICATE_REPORTS_STATE_ATTRIBUTE, KeyType: 'HASH' },
        { AttributeName: DUPLICATE_REPORTS_STATE_SK_ATTRIBUTE, KeyType: 'RANGE' },
      ],
      Projection: { ProjectionType: 'ALL' },
    });
  });

  it('expires daily counters, runs, rejections and idempotency keys via TTL, nothing else', () => {
    const ttl = Object.fromEntries(
      Object.entries(md.findResources('AWS::DynamoDB::GlobalTable')).map(([id, r]) => [
        id.replace(/[0-9A-F]{8}$/, ''),
        (r as Resource).Properties['TimeToLiveSpecification'],
      ]),
    );
    expect(ttl['MetricCounters']).toEqual({
      AttributeName: METRIC_COUNTERS_TTL_ATTRIBUTE,
      Enabled: true,
    });
    for (const name of ['ConnectorRuns', 'RunRejections']) {
      expect(ttl[name]).toEqual({ AttributeName: CONNECTOR_RUNS_TTL_ATTRIBUTE, Enabled: true });
    }
    expect(ttl['IdempotencyKeys']).toEqual({
      AttributeName: IDEMPOTENCY_KEYS_TTL_ATTRIBUTE,
      Enabled: true,
    });
    for (const name of [
      'ListingVersions',
      'ListingKeys',
      'Agencies',
      'Memberships',
      'DuplicateIndex',
      'DuplicateReports',
    ]) {
      expect(ttl[name]).toBeUndefined();
    }
  });

  it('keeps snapshots in a private SSE-KMS bucket without versioning (Req 9.2)', () => {
    const bucket = only(md, 'AWS::S3::Bucket', 'VersionSnapshots').Properties;
    expect(bucket['PublicAccessBlockConfiguration']).toEqual({
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    });
    expect(bucket['BucketEncryption']).toEqual({
      ServerSideEncryptionConfiguration: [
        {
          BucketKeyEnabled: true,
          ServerSideEncryptionByDefault: {
            SSEAlgorithm: 'aws:kms',
            KMSMasterKeyID: { 'Fn::GetAtt': [expect.stringMatching(/^SnapshotKey/), 'Arn'] },
          },
        },
      ],
    });
    expect(bucket).not.toHaveProperty('VersioningConfiguration');
    md.hasResourceProperties('AWS::KMS::Key', { EnableKeyRotation: true });
  });

  it('is deployed before the stacks that read it and references none of them', () => {
    const { managementData, api, ingestion, admin, management } = app.stacks;
    expect(managementData.dependencies).toEqual([]);
    for (const stack of [api, ingestion, admin, management]) {
      expect(stack.dependencies).toContain(managementData);
    }
  });
});

describe('ManagementStack (task 12.2)', () => {
  const m = templateOf(app, 'management');
  const env = () => variables(m, 'ManagementFunction');
  const statements = () => roleStatements(m, 'ManagementFunction');

  it('deploys after the Frontend-, Identity- and AdminStack', () => {
    const deps = app.stacks.management.dependencies;
    for (const stack of [app.stacks.frontend, app.stacks.identity, app.stacks.admin]) {
      expect(deps).toContain(stack);
    }
  });

  it('routes every path and method of the REST API to the management Lambda', () => {
    m.resourceCountIs('AWS::ApiGateway::RestApi', 1);
    m.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: '{proxy+}' });
    m.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'ANY',
      AuthorizationType: 'NONE',
      Integration: Match.objectLike({ Type: 'AWS_PROXY' }),
    });
  });

  it('protects the stage with a WAF rate rule (design: ManagementApi mit WAF)', () => {
    const acl = only(m, 'AWS::WAFv2::WebACL', 'ManagementApiWebAcl');
    expect(acl.Properties).toMatchObject({
      Scope: 'REGIONAL',
      Rules: [
        expect.objectContaining({
          Statement: { RateBasedStatement: expect.objectContaining({ AggregateKeyType: 'IP' }) },
        }),
      ],
    });
    const [aclId] = Object.keys(m.findResources('AWS::WAFv2::WebACL'));
    const [stageId] = Object.keys(m.findResources('AWS::ApiGateway::Stage'));
    m.hasResourceProperties('AWS::WAFv2::WebACLAssociation', {
      WebACLArn: { 'Fn::GetAtt': [aclId, 'Arn'] },
    });
    expect(JSON.stringify(m.findResources('AWS::WAFv2::WebACLAssociation'))).toContain(stageId);
  });

  it('allows the SPA origin with Authorization (CORS) and sets it on gateway errors', () => {
    const origins = JSON.stringify(env()['MANAGEMENT_CORS_ALLOWED_ORIGINS']);
    expect(origins).toContain('https://');
    expect(origins).toMatch(/Distribution/);
    m.hasResourceProperties('AWS::ApiGateway::GatewayResponse', {
      ResponseType: 'THROTTLED',
      ResponseParameters: Match.objectLike({
        'gatewayresponse.header.Access-Control-Allow-Origin': Match.anyValue(),
      }),
    });
  });

  it('sets every variable the management Lambda and its route groups read', () => {
    const vars = env();
    const groups = [
      MANAGEMENT_ENV,
      ...Object.values(MANAGEMENT_ROUTE_ENV),
      { frontendOrigin: 'FRONTEND_ORIGIN_SSM_PARAMETER' },
    ];
    for (const name of groups.flatMap((group) => Object.values(group))) {
      expect(vars[name]).toBeDefined();
    }
    expect(vars['FRONTEND_ORIGIN_SSM_PARAMETER']).toBe('/open-estate/dev/frontend-origin');
    expect(vars[MANAGEMENT_ENV.rateLimitParameter]).toBe(managementRateLimitParameterName('dev'));
    expect(vars['ALARM_NAME_PREFIX']).toBe('OpenEstate-dev-Monitoring-');
    expect(vars['METRICS_NAMESPACE']).toBe('OpenEstate');
  });

  it('mirrors the route-group variables and config files of @open-estate/management', () => {
    expect(MANAGEMENT_ROUTE_ENV.identity).toEqual(IDENTITY_ENV);
    expect(MANAGEMENT_ROUTE_ENV.listings).toEqual(LISTING_ROUTES_ENV);
    expect(MANAGEMENT_ROUTE_ENV.monitoring).toEqual(MONITORING_ENV);
    expect(MANAGEMENT_ROUTE_ENV.platform).toEqual(PLATFORM_ENV);
    expect(MANAGEMENT_ROUTE_ENV.duplicates).toEqual(DUPLICATES_ENV);
    expect(MANAGEMENT_CONFIG_FILES).toEqual(LISTING_CONFIG_FILES);
  });

  it('creates the management rate-limit parameter and reads it plus frontend-origin', () => {
    m.hasResourceProperties('AWS::SSM::Parameter', {
      Name: managementRateLimitParameterName('dev'),
      Value: JSON.stringify(DEFAULT_RATE_LIMIT),
    });
    const ssmRead = statements().find((s) => actions(s).includes('ssm:GetParameter'));
    const resources = JSON.stringify(ssmRead?.Resource);
    expect(resources).toContain(':parameter/open-estate/dev/frontend-origin');
    expect(resources).toContain(':parameter/open-estate/dev/management-rate-limit');
  });

  it('never grants UpdateItem/DeleteItem on AuditLog to any Lambda role of the app (Req 11.3)', () => {
    const forbidden = ['dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:*'];
    for (const [name, template] of Object.entries(t)) {
      const all = Object.values(template.findResources('AWS::IAM::Policy')).flatMap(
        (p) =>
          (p as { Properties: { PolicyDocument: { Statement: Statement[] } } }).Properties
            .PolicyDocument.Statement,
      );
      const onAuditLog = all.filter((s) => JSON.stringify(s.Resource).includes('AuditLog'));
      for (const statement of onAuditLog) {
        expect({ stack: name, actions: actions(statement) }).toEqual({
          stack: name,
          actions: expect.not.arrayContaining(forbidden),
        });
      }
    }
    expect(actionsOn(statements(), 'AuditLog')).toEqual(['dynamodb:PutItem', 'dynamodb:Query']);
  });

  it('may reload only the API, MCP and connector functions and itself (Req 10.7)', () => {
    const reload = statements().filter((s) =>
      actions(s).includes('lambda:UpdateFunctionConfiguration'),
    );
    expect(reload).toHaveLength(2);
    const resources = reload.flatMap((s) => [s.Resource].flat()).map((r) => JSON.stringify(r));
    expect(resources).toHaveLength(4);
    expect(resources.filter((r) => /ListingsFunction/.test(r))).toHaveLength(1);
    expect(resources.filter((r) => /McpFunction/.test(r))).toHaveLength(1);
    expect(resources.filter((r) => /Connectorpartnerdb/.test(r))).toHaveLength(1);
    // Itself via a separate policy (the default policy may not reference the function).
    expect(resources.filter((r) => /ManagementFunction/.test(r))).toHaveLength(1);
    expect(JSON.stringify(env()['RELOAD_FUNCTION_NAMES'])).toMatch(/ListingsFunction/);
    expect(JSON.stringify(env()['RELOAD_FUNCTION_NAMES'])).not.toMatch(/ManagementFunction/);
  });

  it('outputs every reload target for the admin CLI, including itself', () => {
    const output = JSON.stringify(m.findOutputs('ReloadFunctionNames'));
    for (const name of [
      'ListingsFunction',
      'McpFunction',
      'Connectorpartnerdb',
      'ManagementFunction',
    ]) {
      expect(output).toContain(name);
    }
  });

  it('offers administrators a managed policy to reload the management function from the CLI', () => {
    // Not attached to any role of the stack: administrators attach it themselves.
    const policies = (
      Object.values(m.findResources('AWS::IAM::ManagedPolicy')) as {
        Properties: { Roles?: unknown; PolicyDocument: { Statement: Statement[] } };
      }[]
    ).filter((p) => p.Properties.Roles === undefined);
    expect(policies).toHaveLength(1);
    const [statement, ...rest] = policies[0]?.Properties.PolicyDocument.Statement ?? [];
    expect(rest).toEqual([]);
    expect(statement && actions(statement)).toEqual([
      'lambda:GetFunctionConfiguration',
      'lambda:UpdateFunctionConfiguration',
    ]);
    expect(JSON.stringify(statement?.Resource)).toMatch(/ManagementFunction/);
    expect(JSON.stringify(m.findOutputs('ReloadPolicyArn'))).toMatch(/ManagementReloadPolicy/);
  });

  it('grants the platform operations of the Admin-API and the Cognito calls', () => {
    const all = statements();
    expect(all.flatMap(actions)).toEqual(
      expect.arrayContaining([
        'states:StartExecution',
        'ssm:PutParameter',
        'cognito-idp:ListUsers',
        'cognito-idp:AdminCreateUser',
        'cloudwatch:GetMetricData',
        'cloudwatch:DescribeAlarms',
      ]),
    );
    const put = all.find((s) => actions(s).includes('ssm:PutParameter'));
    expect(JSON.stringify(put?.Resource)).toMatch(
      /access-mode.*rate-limit|rate-limit.*access-mode/,
    );
    expect(JSON.stringify(put?.Resource)).not.toContain('management-rate-limit');
    // `*` only for the CloudWatch reads.
    const wildcard = all.filter((s) => [s.Resource].flat().includes('*'));
    expect(wildcard.flatMap(actions).sort()).toEqual([
      'cloudwatch:DescribeAlarms',
      'cloudwatch:GetMetricData',
      'cloudwatch:ListMetrics',
    ]);
  });

  it('reads and writes snapshots but never deletes them', () => {
    const snapshot = actionsOn(statements(), 'VersionSnapshots');
    expect(snapshot).toEqual(
      expect.arrayContaining(['s3:GetObject', 's3:PutObject', 's3:ListBucket']),
    );
    expect(snapshot).not.toContain('s3:DeleteObject');
  });

  it('feeds the UsageAggregator from the API and MCP log groups (Req 13.4)', () => {
    expect(variables(m, 'UsageAggregator')[USAGE_AGGREGATOR_ENV.metricCountersTable]).toBeDefined();
    const filters = Object.values(m.findResources('AWS::Logs::SubscriptionFilter')).map(
      (r) => (r as Resource).Properties,
    );
    expect(filters).toHaveLength(2);
    for (const filter of filters) {
      expect(filter['FilterPattern']).toBe(USAGE_LOG_FILTER_PATTERN);
      expect(JSON.stringify(filter['DestinationArn'])).toMatch(/UsageAggregator/);
    }
    expect(JSON.stringify(filters.map((f) => f['LogGroupName']))).toMatch(
      /ListingsFunctionLogs.*McpFunctionLogs/,
    );
    expect(actionsOn(roleStatements(m, 'UsageAggregator'), 'MetricCounters')).toEqual([
      'dynamodb:UpdateItem',
    ]);
  });

  it('writes runtime-config.json with the portal block into the frontend bucket', () => {
    const deployment = Object.values(m.findResources('Custom::CDKBucketDeployment')).map(
      (r) => (r as Resource).Properties,
    );
    expect(deployment).toHaveLength(1);
    expect(deployment[0]).toMatchObject({
      Prune: false,
      DistributionPaths: ['/runtime-config.json'],
    });
    const markers = JSON.stringify(deployment[0]?.['SourceMarkers']);
    expect(markers).toMatch(/PortalClient/);
    expect(markers).toMatch(/UserPool/);
    expect(markers).toMatch(/ManagementApi/);
    expect(JSON.stringify(deployment[0]?.['DestinationBucketName'])).toMatch(/SiteBucket/);
  });

  it('creates no Plattform_Admin bootstrap without initialPlatformAdminEmail', () => {
    expect(app.stacks.management.bootstrap).toBeUndefined();
    expect(JSON.stringify(m.toJSON())).not.toContain('INITIAL_PLATFORM_ADMIN_EMAIL');
  });
});

describe('Duplikat_Abgleich in the ManagementStack (duplicate-detection task 11.3, 11.5)', () => {
  const m = templateOf(app, 'management');
  const sweep = () => roleStatements(m, 'DuplicateSweepFunction');
  const machine = () => only(m, 'AWS::StepFunctions::StateMachine', 'DuplicateSweepStateMachine');

  it('runs the sweep Lambda for up to 15 minutes with its stores and the frontend origin', () => {
    const fn = only(m, 'AWS::Lambda::Function', 'DuplicateSweepFunction').Properties;
    expect(fn['Timeout']).toBe(900);
    const vars = variables(m, 'DuplicateSweepFunction');
    for (const name of Object.values(DUPLICATE_SWEEP_ENV)) expect(vars[name]).toBeDefined();
    expect(JSON.stringify(vars[DUPLICATE_SWEEP_ENV.duplicateReportsTable])).toMatch(
      /DuplicateReports/,
    );
    expect(vars['FRONTEND_ORIGIN_SSM_PARAMETER']).toBe('/open-estate/dev/frontend-origin');
    expect(vars['POWERTOOLS_METRICS_NAMESPACE']).toBe('OpenEstate');
  });

  it('defines a standard state machine: 4 h timeout, Maps over the segments, retries (Req 10.8)', () => {
    const definition = JSON.stringify(machine().Properties['DefinitionString']);
    expect(definition).toContain('\\"TimeoutSeconds\\":14400');
    for (const state of ['Prepare', 'INDEXPhase', 'ORPHANPhase', 'MATCHPhase', 'RESOLVEStep']) {
      expect(definition).toContain(`\\"${state}\\"`);
    }
    expect(definition).toContain('\\"ItemsPath\\":\\"$.run.segments\\"');
    expect(definition).toContain('\\"MaxAttempts\\":3');
    expect(definition).toContain('\\"ReportFailure\\"');
    expect(machine().Properties['StateMachineType']).toBe('STANDARD');
  });

  it('renders valid task states: object parameters, the part state as the step input', () => {
    const definition = machine().Properties['DefinitionString'] as {
      'Fn::Join': [string, unknown[]];
    };
    const asl = JSON.parse(
      definition['Fn::Join'][1].map((part) => (typeof part === 'string' ? part : 'ref')).join(''),
    ) as { States: Record<string, Record<string, unknown>> };
    const states: [string, Record<string, unknown>][] = [];
    const collect = (all: Record<string, Record<string, unknown>>) => {
      for (const [name, state] of Object.entries(all)) {
        states.push([name, state]);
        for (const branch of (state['Branches'] as { States: typeof all }[] | undefined) ?? []) {
          collect(branch.States);
        }
        const processor = state['ItemProcessor'] as { States: typeof all } | undefined;
        if (processor !== undefined) collect(processor.States);
      }
    };
    collect(asl.States);
    const tasks = states.filter(([, state]) => state['Type'] === 'Task');
    expect(tasks.map(([name]) => name).sort()).toEqual([
      'Finish',
      'INDEXStep',
      'MATCHStep',
      'ORPHANStep',
      'Prepare',
      'RESOLVEStep',
      'ReportFailure',
    ]);
    for (const [, state] of tasks) {
      if ('Parameters' in state) expect(typeof state['Parameters']).toBe('object');
    }
    const byName = Object.fromEntries(states);
    expect(byName['INDEXStep']).not.toHaveProperty('Parameters');
    expect(byName['RESOLVEStep']).toMatchObject({
      InputPath: '$.resolve',
      ResultPath: '$.resolve',
    });
    expect(byName['INDEXPhase']).toMatchObject({
      ItemsPath: '$.run.segments',
      ItemSelector: { 'segment.$': '$$.Map.Item.Value', phase: 'INDEX' },
      ResultSelector: { 'counts.$': '$[*].counts' },
    });
  });

  it('starts it daily at the configured time (UTC, default 03:00; Req 10.1)', () => {
    const schedule = only(m, 'AWS::Scheduler::Schedule', 'DuplicateSweepSchedule').Properties;
    expect(schedule).toMatchObject({
      ScheduleExpression: 'cron(0 3 * * ? *)',
      ScheduleExpressionTimezone: 'UTC',
      State: 'ENABLED',
    });
    expect(JSON.stringify(schedule['Target'])).toMatch(/DuplicateSweepStateMachine/);
  });

  it('alarms on failed and timed-out runs and notifies the platform topic (Req 10.8)', () => {
    const alarm = only(m, 'AWS::CloudWatch::Alarm', 'DuplicateSweepRunFailed').Properties;
    expect(alarm['AlarmName']).toBe('OpenEstate-dev-Monitoring-DuplicateSweepFailed');
    const metrics = JSON.stringify(alarm['Metrics']);
    expect(metrics).toContain('ExecutionsFailed');
    expect(metrics).toContain('ExecutionsTimedOut');
    expect(JSON.stringify(alarm['AlarmActions'])).toMatch(/AlarmTopic/);
  });

  it('grants the sweep Lambda least privilege: flags only, AuditLog append-only', () => {
    const statements = sweep();
    expect(actionsOn(statements, 'AuditLog').sort()).toEqual(['dynamodb:PutItem']);
    // Cross-stack reference to the DataStack's `Listings` table.
    const listings = actionsOn(statements, 'GetAttListings');
    expect(listings).toEqual(
      expect.arrayContaining(['dynamodb:Scan', 'dynamodb:BatchGetItem', 'dynamodb:UpdateItem']),
    );
    expect(listings).not.toContain('dynamodb:PutItem');
    expect(listings).not.toContain('dynamodb:DeleteItem');
    expect(actionsOn(statements, 'DuplicateReports')).toEqual(
      expect.arrayContaining(['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query']),
    );
    expect(actionsOn(statements, 'MetricCounters')).toEqual(['dynamodb:UpdateItem']);
    expect(statements.flatMap((s) => [s.Resource].flat())).not.toContain('*');
  });

  it('ends a run right after Prepare while the detection is switched off', () => {
    const definition = machine().Properties['DefinitionString'] as {
      'Fn::Join': [string, unknown[]];
    };
    const asl = JSON.parse(
      definition['Fn::Join'][1].map((part) => (typeof part === 'string' ? part : 'ref')).join(''),
    ) as { States: Record<string, { Branches: { States: Record<string, unknown> }[] }> };
    const run = asl.States['Run']?.Branches[0]?.States ?? {};
    expect(run['Prepare']).toMatchObject({ Next: 'DetectionEnabled' });
    expect(run['DetectionEnabled']).toEqual({
      Type: 'Choice',
      Choices: [{ Variable: '$.run.enabled', BooleanEquals: false, Next: 'DetectionDisabled' }],
      Default: 'INDEXPhase',
    });
    expect(run['DetectionDisabled']).toMatchObject({ Type: 'Succeed' });
    const vars = variables(m, 'DuplicateSweepFunction');
    expect(vars[DUPLICATE_SWEEP_ENV.duplicateDetectionParameter]).toBe(
      '/open-estate/dev/duplicate-detection',
    );
    const read = sweep().find((st) => actions(st).includes('ssm:GetParameters'));
    expect(JSON.stringify(read?.Resource)).toContain(
      ':parameter/open-estate/dev/duplicate-detection',
    );
  });

  it('lets the management Lambda read and switch the duplicate detection', () => {
    expect(variables(m, 'ManagementFunction')['DUPLICATE_DETECTION_PARAMETER_NAME']).toBe(
      '/open-estate/dev/duplicate-detection',
    );
    const all = roleStatements(m, 'ManagementFunction');
    const read = all.find((st) => actions(st).includes('ssm:GetParameters'));
    const put = all.find((st) => actions(st).includes('ssm:PutParameter'));
    for (const statement of [read, put]) {
      expect(JSON.stringify(statement?.Resource)).toContain(
        ':parameter/open-estate/dev/duplicate-detection',
      );
    }
  });

  it('lets the management Lambda start the sweep and review the Treffer (Req 10.2, 11.3)', () => {
    const statements = roleStatements(m, 'ManagementFunction');
    expect(actionsOn(statements, 'DuplicateSweepStateMachine')).toEqual(
      expect.arrayContaining(['states:ListExecutions', 'states:StartExecution']),
    );
    expect(actionsOn(statements, 'DuplicateReports')).toEqual(
      expect.arrayContaining(['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query']),
    );
    expect(actionsOn(statements, 'DuplicateReports')).not.toContain('dynamodb:DeleteItem');
    expect(
      JSON.stringify(variables(m, 'ManagementFunction')['DUPLICATE_SWEEP_STATE_MACHINE_ARN']),
    ).toMatch(/DuplicateSweepStateMachine/);
  });
});

describe('FrontendStack in the platform wiring', () => {
  const f = templateOf(app, 'frontend');

  it('extends connect-src by the Management_API and Cognito origins (CSP)', () => {
    const policy = Object.values(f.findResources('AWS::CloudFront::ResponseHeadersPolicy'))[0] as {
      Properties: {
        ResponseHeadersPolicyConfig: {
          SecurityHeadersConfig: { ContentSecurityPolicy: { ContentSecurityPolicy: unknown } };
        };
      };
    };
    const csp = JSON.stringify(
      policy.Properties.ResponseHeadersPolicyConfig.SecurityHeadersConfig.ContentSecurityPolicy
        .ContentSecurityPolicy,
    );
    expect(csp).toContain('https://*.execute-api.');
    expect(csp).toContain('.amazoncognito.com');
    expect(csp).toContain('https://cognito-idp.');
    expect(csp).toContain('open-estate-dev-');
  });

  it('leaves runtime-config.json to the ManagementStack', () => {
    const deployments = Object.values(f.findResources('Custom::CDKBucketDeployment'));
    expect(JSON.stringify(deployments)).not.toMatch(/apiBaseUrl/);
  });
});

describe('ManagementStack with initialPlatformAdminEmail', () => {
  it('bootstraps the first Plattform_Admin on Memberships and PlatformCounters (Req 10.10)', () => {
    const synthesized = synthPlatform({
      [IDENTITY_CONTEXT_KEYS.initialPlatformAdminEmail]: 'admin@example.org',
    });
    expect(synthesized.stacks.management.bootstrap).toBeDefined();
    const vars = variables(templateOf(synthesized, 'management'), 'PlatformAdminBootstrapFunction');
    expect(vars['INITIAL_PLATFORM_ADMIN_EMAIL']).toBe('admin@example.org');
    expect(JSON.stringify(vars['MEMBERSHIPS_TABLE_NAME'])).toMatch(/Memberships/);
    expect(JSON.stringify(vars['PLATFORM_COUNTERS_TABLE_NAME'])).toMatch(/PlatformCounters/);
  });
});
