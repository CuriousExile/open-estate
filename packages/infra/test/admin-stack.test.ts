import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { ADMIN_ENV, DELETION_ENV, OVERDUE_CHECK_ENV } from '@open-estate/admin';
import { DELETION_REQUESTS_BY_STATUS_INDEX, LISTINGS_BY_SOURCE_INDEX } from '@open-estate/core';
import { ERROR_CODES, ERROR_HTTP_STATUS, type ErrorResponse } from '@open-estate/shared';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { ResponseType } from 'aws-cdk-lib/aws-apigateway';
import type { ITableV2 } from 'aws-cdk-lib/aws-dynamodb';
import {
  ADMIN_GATEWAY_RESPONSES,
  ADMIN_ROUTE_PREFIX,
  AdminStack,
  DELETION_PERMANENT_ERRORS,
  OVERDUE_CHECK_SCHEDULE,
} from '../src/admin-stack';
import { ApiStack } from '../src/api-stack';
import { DEFAULT_CONFIG_DIR, resolveEnvironment, resolvePlatformSettings } from '../src/config';
import { DataStack, frontendOriginParameterName } from '../src/data-stack';
import { connectorsFromConfigFiles, IngestionStack } from '../src/ingestion-stack';
import { ManagementDataStack } from '../src/management-stack';

const CDK_CONTEXT = (
  JSON.parse(readFileSync(path.join(__dirname, '../cdk.json'), 'utf8')) as {
    context: Record<string, unknown>;
  }
).context;

/**
 * Data, Api and Admin stack like `app.ts`; bundling skipped (see stacks.test.ts). With
 * `connectors`, a config directory with that `connectors.json` is used and an IngestionStack is
 * added, whose connector functions join the reloadable functions as in `app.ts`.
 */
function synth(envName = 'dev', connectors?: unknown) {
  const configDir =
    connectors === undefined ? undefined : mkdtempSync(path.join(tmpdir(), 'open-estate-admin-'));
  try {
    if (configDir !== undefined) {
      cpSync(DEFAULT_CONFIG_DIR, configDir, { recursive: true });
      writeFileSync(path.join(configDir, 'connectors.json'), JSON.stringify(connectors));
    }
    return synthIn(envName, configDir);
  } finally {
    if (configDir !== undefined) rmSync(configDir, { recursive: true, force: true });
  }
}

function synthIn(envName: string, configDir: string | undefined) {
  const config = resolveEnvironment(envName);
  const app = new App({
    context: {
      ...CDK_CONTEXT,
      'aws:cdk:bundling-stacks': [],
      ...(configDir !== undefined && { configDir }),
    },
  });
  const settings = resolvePlatformSettings((key) => app.node.tryGetContext(key));
  const data = new DataStack(app, 'Data', { environment: config, settings });
  const ingestion =
    configDir === undefined
      ? undefined
      : new IngestionStack(app, 'Ingestion', {
          tables: { listings: data.listingsTable, deletionBlocklist: data.deletionBlocklistTable },
          configBucket: data.configBucket,
          connectors: connectorsFromConfigFiles(data.configFiles),
          removalPolicy: config.removalPolicy,
          observability: settings.observability,
        });
  const api = new ApiStack(app, 'Api', {
    tables: {
      listings: data.listingsTable,
      apiKeys: data.apiKeysTable,
      rateLimitCounters: data.rateLimitCountersTable,
      agencies: new ManagementDataStack(app, 'ManagementData', {
        removalPolicy: config.removalPolicy,
      }).agenciesTable,
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
    observability: settings.observability,
  });
  const reloadableFunctions = [
    api.listingsFunction,
    api.mcpFunction,
    ...(ingestion?.connectors ?? []).map((connector) => connector.function),
  ];
  const admin = new AdminStack(app, 'Admin', {
    tables: {
      listings: data.listingsTable,
      apiKeys: data.apiKeysTable,
      deletionRequests: data.deletionRequestsTable,
      deletionBlocklist: data.deletionBlocklistTable,
      auditLog: data.auditLogTable,
    },
    parameterNames: data.parameterNames,
    reloadableFunctions,
    stageName: config.stageName,
    removalPolicy: config.removalPolicy,
    observability: settings.observability,
  });
  const template = Template.fromStack(admin);
  // Cross-stack references resolve to their imports only after synthesis.
  const ref = (value: string): unknown => admin.resolve(value);
  const indexRef = (table: ITableV2, name: string) => ref(`${table.tableArn}/index/${name}`);
  return {
    admin,
    template,
    stageName: config.stageName,
    reloadArns: reloadableFunctions.map((fn) => ref(fn.functionArn)),
    reloadNames: reloadableFunctions.map((fn) => ref(fn.functionName)),
    refs: {
      listings: ref(data.listingsTable.tableArn),
      listingsBySource: indexRef(data.listingsTable, LISTINGS_BY_SOURCE_INDEX),
      apiKeys: ref(data.apiKeysTable.tableArn),
      deletionRequests: ref(data.deletionRequestsTable.tableArn),
      deletionRequestsByStatus: indexRef(
        data.deletionRequestsTable,
        DELETION_REQUESTS_BY_STATUS_INDEX,
      ),
      deletionBlocklist: ref(data.deletionBlocklistTable.tableArn),
      auditLog: ref(data.auditLogTable.tableArn),
      accessModeParameter: ssmArn(data.parameterNames.accessMode),
      rateLimitParameter: ssmArn(data.parameterNames.rateLimit),
      stateMachine: ref(admin.deletionStateMachine.stateMachineArn),
      topic: ref(admin.overdueTopic.topicArn),
    },
  };
}

/** Expected ARN of an SSM parameter (spelled out instead of reusing `ssmParameterArn`). */
const ssmArn = (name: string) => ({
  'Fn::Join': [
    '',
    [
      'arn:',
      { Ref: 'AWS::Partition' },
      ':ssm:',
      { Ref: 'AWS::Region' },
      ':',
      { Ref: 'AWS::AccountId' },
      `:parameter${name}`,
    ],
  ],
});

const dev = synth();
const { template, reloadArns } = dev;

type Statement = { Action: string | string[]; Resource: unknown };

/** Statements of the default policy of a function's role. */
function statementsOf(functionId: string): Statement[] {
  const policies = template.findResources('AWS::IAM::Policy', {
    Properties: { Roles: [{ Ref: Match.stringLikeRegexp(`^${functionId}ServiceRole`) }] },
  });
  return Object.values(policies).flatMap(
    (p) =>
      (p as { Properties: { PolicyDocument: { Statement: Statement[] } } }).Properties
        .PolicyDocument.Statement,
  );
}

const actionsOf = (functionId: string) =>
  statementsOf(functionId)
    .flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]))
    .sort();

function environmentOf(functionId: string): Record<string, unknown> {
  const fns = Object.entries(template.findResources('AWS::Lambda::Function')).filter(([id]) =>
    id.startsWith(functionId),
  );
  expect(fns).toHaveLength(1);
  return (fns[0]?.[1] as { Properties: { Environment: { Variables: Record<string, unknown> } } })
    .Properties.Environment.Variables;
}

describe('AdminStack: Admin-API (Req 18.11)', () => {
  it('requires AWS_IAM on every method; one ANY proxy under /admin', () => {
    const methods = Object.values(template.findResources('AWS::ApiGateway::Method'));
    expect(methods).toHaveLength(1);
    for (const method of methods) {
      expect(method).toMatchObject({
        Properties: { AuthorizationType: 'AWS_IAM', HttpMethod: 'ANY' },
      });
    }
    template.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: '{proxy+}' });
    template.hasResourceProperties('AWS::ApiGateway::Resource', { PathPart: 'admin' });
  });

  it('answers unsigned and unauthorized requests with 403 ApiError FORBIDDEN', () => {
    const forbidden = [
      ResponseType.MISSING_AUTHENTICATION_TOKEN,
      ResponseType.ACCESS_DENIED,
      ResponseType.INVALID_SIGNATURE,
      ResponseType.EXPIRED_TOKEN,
    ];
    for (const type of forbidden) {
      const response = Object.values(
        template.findResources('AWS::ApiGateway::GatewayResponse', {
          Properties: { ResponseType: type.responseType },
        }),
      )[0] as
        | { Properties: { StatusCode: string; ResponseTemplates: Record<string, string> } }
        | undefined;
      expect(response?.Properties.StatusCode).toBe(String(ERROR_HTTP_STATUS.FORBIDDEN));
      const body = JSON.parse(
        response?.Properties.ResponseTemplates['application/json'] ?? '{}',
      ) as ErrorResponse;
      expect(body.errors).toEqual([{ code: 'FORBIDDEN', message: expect.any(String) }]);
    }
    template.resourceCountIs('AWS::ApiGateway::GatewayResponse', ADMIN_GATEWAY_RESPONSES.length);
  });

  it('passes every ADMIN_ENV variable to the admin Lambda', () => {
    expect(Object.keys(environmentOf('AdminFunction'))).toEqual(
      expect.arrayContaining(Object.values(ADMIN_ENV)),
    );
  });

  it('grants the admin Lambda exactly its calls, incl. StartExecution of the workflow', () => {
    expect(actionsOf('AdminFunction')).toEqual(
      [
        'dynamodb:DeleteItem',
        'dynamodb:GetItem',
        'dynamodb:GetItem',
        'dynamodb:PutItem',
        'dynamodb:PutItem',
        'dynamodb:PutItem',
        'dynamodb:Query',
        'dynamodb:UpdateItem',
        'ssm:PutParameter',
        'states:StartExecution',
      ].sort(),
    );
  });
});

describe('AdminStack: deletion workflow (Req 18.4)', () => {
  const definition = () => {
    const machines = Object.values(template.findResources('AWS::StepFunctions::StateMachine'));
    expect(machines).toHaveLength(1);
    const parts = (
      machines[0] as { Properties: { DefinitionString: { 'Fn::Join': [string, unknown[]] } } }
    ).Properties.DefinitionString['Fn::Join'][1];
    return parts.filter((p): p is string => typeof p === 'string').join('"ARN"');
  };

  it('resolves pages, deletes targets in a distributed map and finalizes', () => {
    const def = definition();
    for (const step of ['resolveTargets', 'deleteListing', 'finalize']) {
      expect(def).toContain(`"step":"${step}"`);
    }
    expect(def).toContain('"Mode":"DISTRIBUTED"');
    expect(def).toContain('"cursor.$":"$.page.nextCursor"');
  });

  it('does not retry permanent errors and retries everything else with backoff', () => {
    const def = definition();
    expect(def).toContain(
      `{"ErrorEquals":${JSON.stringify(DELETION_PERMANENT_ERRORS)},"MaxAttempts":0}`,
    );
    expect(def).toContain('"ErrorEquals":["States.ALL"]');
    expect(def).toContain('"BackoffRate":2');
  });

  it('passes the deletion tables to the task Lambda', () => {
    expect(Object.keys(environmentOf('DeletionTaskFunction'))).toEqual(
      expect.arrayContaining(Object.values(DELETION_ENV)),
    );
  });
});

describe('AdminStack: overdue check (Req 18.10)', () => {
  it('invokes the overdue check hourly via EventBridge Scheduler', () => {
    template.hasResourceProperties('AWS::Scheduler::Schedule', {
      ScheduleExpression: OVERDUE_CHECK_SCHEDULE,
      State: 'ENABLED',
      Target: {
        Arn: { 'Fn::GetAtt': [Match.stringLikeRegexp('^OverdueCheckFunction'), 'Arn'] },
      },
    });
    expect(OVERDUE_CHECK_SCHEDULE).toBe('rate(1 hour)');
  });

  it('publishes to an encrypted, TLS-only SNS topic', () => {
    const topics = Object.values(template.findResources('AWS::SNS::Topic'));
    expect(topics).toHaveLength(1);
    expect(JSON.stringify(topics[0])).toContain(':alias/aws/sns');
    template.hasResourceProperties('AWS::SNS::TopicPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Deny',
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          }),
        ]),
      },
    });
    const env = environmentOf('OverdueCheckFunction');
    expect(Object.keys(env)).toEqual(expect.arrayContaining(Object.values(OVERDUE_CHECK_ENV)));
    expect(env[OVERDUE_CHECK_ENV.overdueTopicArn]).toEqual({
      Ref: expect.stringMatching(/^OverdueDeletionTopic/),
    });
    expect(actionsOf('OverdueCheckFunction')).toContain('sns:Publish');
  });
});

describe('AdminStack: Administrator policy', () => {
  const statements = () => {
    const policies = Object.values(template.findResources('AWS::IAM::ManagedPolicy'));
    expect(policies).toHaveLength(1);
    return (policies[0] as { Properties: { PolicyDocument: { Statement: Statement[] } } })
      .Properties.PolicyDocument.Statement;
  };

  it('allows execute-api:Invoke on /admin/* of the stage only', () => {
    const invoke = statements().find((s) => s.Action === 'execute-api:Invoke');
    expect(JSON.stringify(invoke?.Resource)).toContain('/dev/*/admin/*');
  });

  it('allows reading and updating the configuration of the reloadable functions', () => {
    const reload = statements().find(
      (s) => Array.isArray(s.Action) && s.Action.includes('lambda:UpdateFunctionConfiguration'),
    );
    expect(reload?.Action).toEqual([
      'lambda:GetFunctionConfiguration',
      'lambda:UpdateFunctionConfiguration',
    ]);
    expect(reload?.Resource).toEqual(reloadArns);
  });

  it('outputs URL, reload functions, topic and policy', () => {
    for (const name of [
      'AdminApiUrl',
      'ReloadFunctionNames',
      'OverdueTopicArn',
      'AdministratorPolicyArn',
    ]) {
      template.hasOutput(name, {});
    }
  });
});

// --- Task 14.11: least privilege, gateway responses, scheduler, SNS, workflow, prod ---

type PolicyResource = {
  Properties: { Roles?: { Ref: string }[]; PolicyDocument: { Statement: PolicyStatementJson[] } };
};
type PolicyStatementJson = {
  Effect: string;
  Action: string | string[];
  Resource: unknown;
  Principal?: unknown;
  Condition?: unknown;
};

const asArray = <T>(value: T | T[]): T[] => (Array.isArray(value) ? value : [value]);

/** Inline policies (AWS::IAM::Policy) attached to the role whose logical id starts with `rolePrefix`. */
function rolePolicies(t: Template, rolePrefix: string): PolicyStatementJson[] {
  return Object.values(t.findResources('AWS::IAM::Policy') as Record<string, PolicyResource>)
    .filter((p) => p.Properties.Roles?.some((r) => r.Ref.startsWith(rolePrefix)))
    .flatMap((p) => p.Properties.PolicyDocument.Statement);
}

/**
 * Allowed (action, resource) pairs, independent of how `minimizePolicies` merges statements.
 * Resources are compared as JSON, so cross-stack imports and `Fn::Join`s must match exactly.
 */
function grants(statements: PolicyStatementJson[]): string[] {
  return statements
    .filter((s) => s.Effect === 'Allow')
    .flatMap((s) =>
      asArray(s.Action).flatMap((action) =>
        asArray(s.Resource).map((resource) => `${action} ${JSON.stringify(resource)}`),
      ),
    )
    .sort();
}

const grant = (actions: string[], resources: unknown[]) =>
  actions.flatMap((action) => resources.map((r) => `${action} ${JSON.stringify(r)}`));

const lambdaGrants = (t: Template, functionId: string) =>
  grants(rolePolicies(t, `${functionId}ServiceRole`));

/** The single resource of `type` whose logical id starts with `prefix`, with its logical id. */
function single(t: Template, type: string, prefix = ''): [string, Record<string, unknown>] {
  const matches = Object.entries(t.findResources(type)).filter(([id]) => id.startsWith(prefix));
  expect(matches).toHaveLength(1);
  const [id, resource] = matches[0] as [string, Record<string, unknown>];
  return [id, resource];
}

const logicalId = (t: Template, type: string, prefix = '') => single(t, type, prefix)[0];
const propsOf = (t: Template, type: string, prefix = '') =>
  single(t, type, prefix)[1]['Properties'] as Record<string, unknown>;

/** `Fn::GetAtt` of a function's ARN plus its qualified versions, as `grantInvoke` renders it. */
const invokeResources = (functionLogicalId: string) => [
  { 'Fn::GetAtt': [functionLogicalId, 'Arn'] },
  { 'Fn::Join': ['', [{ 'Fn::GetAtt': [functionLogicalId, 'Arn'] }, ':*']] },
];

const LAMBDA_IDS = ['AdminFunction', 'DeletionTaskFunction', 'OverdueCheckFunction'] as const;

describe('AdminStack: Admin-API routes and gateway responses (Req 18.11)', () => {
  const restApiId = logicalId(template, 'AWS::ApiGateway::RestApi');

  it('defines /admin/{proxy+} below the root and no method outside it (no root, no OPTIONS)', () => {
    const resources = Object.entries(template.findResources('AWS::ApiGateway::Resource'));
    expect(resources).toHaveLength(2);
    const byPath = (part: string) =>
      resources.find(
        ([, r]) => (r as { Properties: { PathPart: string } }).Properties.PathPart === part,
      );
    const admin = byPath(ADMIN_ROUTE_PREFIX);
    const proxy = byPath('{proxy+}');
    expect(admin?.[1]).toEqual({
      Type: 'AWS::ApiGateway::Resource',
      Properties: {
        ParentId: { 'Fn::GetAtt': [restApiId, 'RootResourceId'] },
        PathPart: ADMIN_ROUTE_PREFIX,
        RestApiId: { Ref: restApiId },
      },
    });
    expect(proxy?.[1]).toMatchObject({ Properties: { ParentId: { Ref: admin?.[0] } } });

    const method = propsOf(template, 'AWS::ApiGateway::Method');
    expect(method).toMatchObject({
      AuthorizationType: 'AWS_IAM',
      HttpMethod: 'ANY',
      ResourceId: { Ref: proxy?.[0] },
      Integration: { Type: 'AWS_PROXY' },
    });
    expect(JSON.stringify(method['Integration'])).toContain(
      `"Fn::GetAtt":["${logicalId(template, 'AWS::Lambda::Function', 'AdminFunction')}","Arn"]`,
    );
    expect(method).not.toHaveProperty('AuthorizerId');
    expect(method).not.toHaveProperty('ApiKeyRequired');
  });

  it('renders every admin gateway response as no-store ErrorResponse with a catalog code', () => {
    const rendered = new Map(
      Object.values(template.findResources('AWS::ApiGateway::GatewayResponse')).map((r) => {
        const p = (r as { Properties: Record<string, unknown> }).Properties;
        return [p['ResponseType'], p];
      }),
    );
    expect([...rendered.keys()].sort()).toEqual(
      ADMIN_GATEWAY_RESPONSES.map((g) => g.type.responseType).sort(),
    );
    for (const { type, statusCode, code, message, retryAfterSeconds } of ADMIN_GATEWAY_RESPONSES) {
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
    }
  });

  it('maps exactly the four authentication failures to 403 FORBIDDEN', () => {
    const forbidden = ADMIN_GATEWAY_RESPONSES.filter((g) => g.code === 'FORBIDDEN')
      .map((g) => g.type.responseType)
      .sort();
    expect(forbidden).toEqual(
      [
        'ACCESS_DENIED',
        'EXPIRED_TOKEN',
        'INVALID_SIGNATURE',
        'MISSING_AUTHENTICATION_TOKEN',
      ].sort(),
    );
    for (const g of ADMIN_GATEWAY_RESPONSES.filter((r) => r.code === 'FORBIDDEN')) {
      expect(g.statusCode).toBe(403);
    }
    // Unsigned requests must not look like "unknown route" (404) on the Admin-API.
    expect(
      ADMIN_GATEWAY_RESPONSES.some(
        (g) => g.code === 'NOT_FOUND' && g.type === ResponseType.MISSING_AUTHENTICATION_TOKEN,
      ),
    ).toBe(false);
  });

  it('attaches no WAF to the Admin-API and renders no WAF_FILTERED response', () => {
    template.resourceCountIs('AWS::WAFv2::WebACL', 0);
    template.resourceCountIs('AWS::WAFv2::WebACLAssociation', 0);
    expect(ADMIN_GATEWAY_RESPONSES.map((g) => g.type)).not.toContain(ResponseType.WAF_FILTERED);
  });

  it('lets API Gateway invoke the admin Lambda only via /admin/* of this API', () => {
    const permissions = Object.values(template.findResources('AWS::Lambda::Permission')).map(
      (p) => (p as { Properties: Record<string, unknown> }).Properties,
    );
    expect(permissions.length).toBeGreaterThan(0);
    for (const p of permissions) {
      expect(p).toMatchObject({
        Action: 'lambda:InvokeFunction',
        Principal: 'apigateway.amazonaws.com',
        FunctionName: {
          'Fn::GetAtt': [logicalId(template, 'AWS::Lambda::Function', 'AdminFunction'), 'Arn'],
        },
      });
      const source = JSON.stringify(p['SourceArn']);
      expect(source).toContain(`{"Ref":"${restApiId}"}`);
      expect(source).toMatch(/\/\*\/admin\/\*"\]\]\}$/);
    }
  });
});

describe('AdminStack: least-privilege Lambda roles', () => {
  const r = dev.refs;

  it('grants the admin Lambda exactly its table, index, SSM and workflow resources', () => {
    expect(lambdaGrants(template, 'AdminFunction')).toEqual(
      [
        ...grant(['dynamodb:PutItem', 'dynamodb:UpdateItem'], [r.apiKeys]),
        ...grant(['ssm:PutParameter'], [r.accessModeParameter, r.rateLimitParameter]),
        ...grant(['dynamodb:PutItem'], [r.auditLog]),
        ...grant(['dynamodb:PutItem', 'dynamodb:GetItem'], [r.deletionRequests]),
        ...grant(['dynamodb:GetItem'], [r.listings]),
        ...grant(['dynamodb:Query'], [r.listingsBySource]),
        ...grant(['dynamodb:DeleteItem'], [r.deletionBlocklist]),
        ...grant(['states:StartExecution'], [r.stateMachine]),
      ].sort(),
    );
  });

  it('grants the deletion task no ApiKeys, SSM, SNS or workflow access', () => {
    expect(lambdaGrants(template, 'DeletionTaskFunction')).toEqual(
      [
        ...grant(['dynamodb:GetItem', 'dynamodb:UpdateItem'], [r.deletionRequests]),
        ...grant(['dynamodb:GetItem', 'dynamodb:DeleteItem'], [r.listings]),
        ...grant(['dynamodb:Query'], [r.listingsBySource]),
        ...grant(['dynamodb:PutItem'], [r.deletionBlocklist, r.auditLog]),
      ].sort(),
    );
  });

  it('grants the overdue check no DeletionBlocklist, ApiKeys, AuditLog or SSM access', () => {
    expect(lambdaGrants(template, 'OverdueCheckFunction')).toEqual(
      [
        ...grant(['dynamodb:Query'], [r.deletionRequestsByStatus, r.listingsBySource]),
        ...grant(['dynamodb:GetItem', 'dynamodb:UpdateItem'], [r.deletionRequests]),
        ...grant(['dynamodb:GetItem'], [r.listings]),
        ...grant(['sns:Publish'], [r.topic]),
      ].sort(),
    );
  });

  it('uses no wildcard resource, no wildcard action and no Scan in any Lambda role', () => {
    for (const id of LAMBDA_IDS) {
      const statements = rolePolicies(template, `${id}ServiceRole`);
      expect(statements.length).toBeGreaterThan(0);
      for (const s of statements) {
        expect(s.Effect).toBe('Allow');
        expect(asArray(s.Resource)).not.toContain('*');
        for (const action of asArray(s.Action)) {
          expect(action).not.toContain('*');
          expect(action).not.toBe('dynamodb:Scan');
        }
      }
    }
  });

  it('lets only the overdue check publish to the topic', () => {
    const publishers = Object.entries(
      template.findResources('AWS::IAM::Policy') as Record<string, PolicyResource>,
    ).filter(([, p]) =>
      p.Properties.PolicyDocument.Statement.some(
        (s) => s.Effect === 'Allow' && asArray(s.Action).some((a) => a.startsWith('sns:')),
      ),
    );
    expect(publishers.map(([id]) => id)).toEqual([
      expect.stringMatching(/^OverdueCheckFunctionServiceRoleDefaultPolicy/),
    ]);
  });
});

describe('AdminStack: overdue scheduler (Req 18.10)', () => {
  const overdueFn = logicalId(template, 'AWS::Lambda::Function', 'OverdueCheckFunction');
  const schedulerRole = logicalId(template, 'AWS::IAM::Role', 'OverdueSchedulerRole');

  it('targets the overdue Lambda hourly with the scheduler role and no retries', () => {
    expect(propsOf(template, 'AWS::Scheduler::Schedule')).toMatchObject({
      ScheduleExpression: 'rate(1 hour)',
      State: 'ENABLED',
      FlexibleTimeWindow: { Mode: 'OFF' },
      Target: {
        Arn: { 'Fn::GetAtt': [overdueFn, 'Arn'] },
        RoleArn: { 'Fn::GetAtt': [schedulerRole, 'Arn'] },
        RetryPolicy: { MaximumRetryAttempts: 0 },
      },
    });
    // No async Lambda retries either: the next hourly run catches up.
    template.hasResourceProperties('AWS::Lambda::EventInvokeConfig', {
      FunctionName: { Ref: overdueFn },
      MaximumRetryAttempts: 0,
    });
  });

  it('lets only scheduler.amazonaws.com of this account assume the role', () => {
    expect(propsOf(template, 'AWS::IAM::Role', 'OverdueSchedulerRole')).toEqual({
      AssumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Action: 'sts:AssumeRole',
            Effect: 'Allow',
            Principal: { Service: 'scheduler.amazonaws.com' },
            Condition: { StringEquals: { 'aws:SourceAccount': { Ref: 'AWS::AccountId' } } },
          },
        ],
      },
      Description: expect.any(String),
    });
  });

  it('allows the scheduler role to invoke only the overdue Lambda', () => {
    expect(grants(rolePolicies(template, 'OverdueSchedulerRole'))).toEqual(
      grant(['lambda:InvokeFunction'], invokeResources(overdueFn)).sort(),
    );
  });
});

describe('AdminStack: overdue topic (Req 18.10)', () => {
  it('encrypts with the AWS managed SNS key', () => {
    expect(propsOf(template, 'AWS::SNS::Topic')['KmsMasterKeyId']).toEqual({
      'Fn::Join': [
        '',
        [
          'arn:',
          { Ref: 'AWS::Partition' },
          ':kms:',
          { Ref: 'AWS::Region' },
          ':',
          { Ref: 'AWS::AccountId' },
          ':alias/aws/sns',
        ],
      ],
    });
  });

  it('has a TLS-only topic policy that grants nothing', () => {
    const topic = logicalId(template, 'AWS::SNS::Topic');
    const policy = propsOf(template, 'AWS::SNS::TopicPolicy') as {
      Topics: unknown;
      PolicyDocument: { Statement: PolicyStatementJson[] };
    };
    expect(policy.Topics).toEqual([{ Ref: topic }]);
    expect(policy.PolicyDocument.Statement).toEqual([
      expect.objectContaining({
        Effect: 'Deny',
        Principal: '*',
        Action: 'sns:Publish',
        Resource: { Ref: topic },
        Condition: { Bool: { 'aws:SecureTransport': 'false' } },
      }),
    ]);
  });

  it('manages no subscriptions (administrators subscribe themselves)', () => {
    template.resourceCountIs('AWS::SNS::Subscription', 0);
    expect(propsOf(template, 'AWS::SNS::Topic')).not.toHaveProperty('Subscription');
  });
});

describe('AdminStack: deletion state machine (Req 18.4)', () => {
  const deletionFn = logicalId(template, 'AWS::Lambda::Function', 'DeletionTaskFunction');

  it('is a STANDARD workflow with a 24 h timeout', () => {
    const machine = propsOf(template, 'AWS::StepFunctions::StateMachine');
    expect(machine['StateMachineType']).toBe('STANDARD');
    const parts = (machine['DefinitionString'] as { 'Fn::Join': [string, unknown[]] })[
      'Fn::Join'
    ][1];
    expect(parts.filter((p) => typeof p === 'string').join('')).toContain(
      `"TimeoutSeconds":${24 * 60 * 60}`,
    );
  });

  it('logs errors only, without execution data, to its own log group', () => {
    const logGroup = logicalId(template, 'AWS::Logs::LogGroup', 'DeletionStateMachineLogs');
    expect(propsOf(template, 'AWS::StepFunctions::StateMachine')['LoggingConfiguration']).toEqual({
      Level: 'ERROR',
      IncludeExecutionData: false,
      Destinations: [
        { CloudWatchLogsLogGroup: { LogGroupArn: { 'Fn::GetAtt': [logGroup, 'Arn'] } } },
      ],
    });
  });

  it('may invoke only the deletion task Lambda', () => {
    const invokes = grants(rolePolicies(template, 'DeletionStateMachineRole')).filter((g) =>
      g.startsWith('lambda:'),
    );
    expect(invokes).toEqual(grant(['lambda:InvokeFunction'], invokeResources(deletionFn)).sort());
  });

  it('starts child executions of itself only (Distributed Map)', () => {
    const starts = grants(rolePolicies(template, 'DeletionStateMachineRole')).filter((g) =>
      g.startsWith('states:StartExecution'),
    );
    expect(starts).toEqual(grant(['states:StartExecution'], [dev.refs.stateMachine]));
  });
});

describe('AdminStack: Administrator policy scope', () => {
  const restApiId = logicalId(template, 'AWS::ApiGateway::RestApi');
  const statements = (t: Template) =>
    (
      propsOf(t, 'AWS::IAM::ManagedPolicy') as {
        PolicyDocument: { Statement: PolicyStatementJson[] };
      }
    ).PolicyDocument.Statement;

  it('allows execute-api:Invoke on this API, this stage and /admin/* only', () => {
    expect(grants(statements(template)).filter((g) => g.startsWith('execute-api:'))).toEqual(
      grant(
        ['execute-api:Invoke'],
        [
          {
            'Fn::Join': [
              '',
              [
                'arn:',
                { Ref: 'AWS::Partition' },
                ':execute-api:',
                { Ref: 'AWS::Region' },
                ':',
                { Ref: 'AWS::AccountId' },
                ':',
                { Ref: restApiId },
                `/${dev.stageName}/*/${ADMIN_ROUTE_PREFIX}/*`,
              ],
            ],
          },
        ],
      ),
    );
  });

  it('grants exactly invoke, reload and subscribe, without wildcard resources', () => {
    const all = statements(template);
    expect(all.every((s) => s.Effect === 'Allow')).toBe(true);
    expect(all.flatMap((s) => asArray(s.Resource))).not.toContain('*');
    expect(grants(all).filter((g) => g.startsWith('sns:'))).toEqual(
      grant(['sns:Subscribe'], [dev.refs.topic]),
    );
    expect(all.flatMap((s) => asArray(s.Action)).sort()).toEqual(
      [
        'execute-api:Invoke',
        'lambda:GetFunctionConfiguration',
        'lambda:UpdateFunctionConfiguration',
        'sns:Subscribe',
      ].sort(),
    );
  });

  it('does not list the admin functions themselves as reloadable', () => {
    const reload = statements(template).find((s) =>
      asArray(s.Action).includes('lambda:UpdateFunctionConfiguration'),
    );
    const adminFnIds = LAMBDA_IDS.map((id) => logicalId(template, 'AWS::Lambda::Function', id));
    for (const id of adminFnIds) expect(JSON.stringify(reload?.Resource)).not.toContain(id);
  });

  describe('with a connector', () => {
    const withConnector = synth('dev', [
      {
        id: 'partner-db',
        type: 'relational-db',
        module: 'relational-db',
        enabled: true,
        schedule: 'rate(1 hour)',
        timeoutSeconds: 600,
        settings: {},
        secretRef: 'open-estate/partner-db',
      },
    ]);

    it('includes listings, MCP and connector functions in reload, policy and output', () => {
      expect(withConnector.reloadArns).toHaveLength(3);
      const reload = statements(withConnector.template).find((s) =>
        asArray(s.Action).includes('lambda:UpdateFunctionConfiguration'),
      );
      expect(reload?.Resource).toEqual(withConnector.reloadArns);
      expect(JSON.stringify(withConnector.reloadArns[2])).toContain('"StackName":"Ingestion"');
      withConnector.template.hasOutput('ReloadFunctionNames', {
        Value: { 'Fn::Join': [',', withConnector.reloadNames] },
      });
    });
  });
});

describe('AdminStack: prod', () => {
  const prod = synth('prod');

  it('scopes the Administrator policy to the prod stage', () => {
    expect(JSON.stringify(prod.template.findResources('AWS::IAM::ManagedPolicy'))).toContain(
      `"/prod/*/${ADMIN_ROUTE_PREFIX}/*"`,
    );
    prod.template.hasResourceProperties('AWS::ApiGateway::Stage', { StageName: 'prod' });
  });

  it('writes the prod SSM parameters', () => {
    expect(lambdaGrants(prod.template, 'AdminFunction')).toEqual(
      expect.arrayContaining(
        grant(['ssm:PutParameter'], [prod.refs.accessModeParameter, prod.refs.rateLimitParameter]),
      ),
    );
    expect(JSON.stringify(prod.refs.accessModeParameter)).toContain('/prod/');
  });

  it('retains the log groups in prod and deletes them in dev', () => {
    const policies = (t: Template) =>
      Object.values(t.findResources('AWS::Logs::LogGroup')).map(
        (g) => (g as { DeletionPolicy?: string }).DeletionPolicy,
      );
    expect(policies(prod.template)).toEqual(Array(4).fill('Retain'));
    expect(policies(template)).toEqual(Array(4).fill('Delete'));
  });

  it('keeps the same security setup as dev', () => {
    for (const type of [
      'AWS::ApiGateway::Method',
      'AWS::ApiGateway::GatewayResponse',
      'AWS::Scheduler::Schedule',
      'AWS::SNS::Topic',
      'AWS::SNS::Subscription',
      'AWS::WAFv2::WebACLAssociation',
    ]) {
      prod.template.resourceCountIs(type, Object.keys(template.findResources(type)).length);
    }
    prod.template.hasResourceProperties('AWS::ApiGateway::Method', {
      AuthorizationType: 'AWS_IAM',
    });
    prod.template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
      LoggingConfiguration: { Level: 'ERROR', IncludeExecutionData: false },
    });
  });
});
