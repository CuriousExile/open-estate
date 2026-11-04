import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { CONNECTOR_LAMBDA_ENV, type ConnectorsFile } from '@open-estate/ingestion';
import { DEFAULT_CONFIG_DIR, resolveEnvironment, resolvePlatformSettings } from '../src/config';
import { DataStack } from '../src/data-stack';
import {
  connectorsFromConfigFiles,
  CONNECTOR_TAG,
  IngestionStack,
  secretResourceArn,
} from '../src/ingestion-stack';

// Basic assertions (task 10.15), per-connector wiring and timeout isolation (task 10.16, below).
// The behavioral half of "a timeout ends only the affected connector" lives in
// packages/ingestion/test/connector-timeout-isolation.test.ts.

const CDK_CONTEXT = (
  JSON.parse(readFileSync(path.join(__dirname, '../cdk.json'), 'utf8')) as {
    context: Record<string, unknown>;
  }
).context;

const CONNECTORS = [
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
  {
    id: 'partner-site',
    type: 'web-crawler',
    module: 'web-crawler',
    enabled: false,
    schedule: 'cron(0 3 * * ? *)',
    settings: {},
  },
];

/** Synthesizes Data + Ingestion like `app.ts` from a config dir; bundling is skipped. */
function synth(connectors: unknown, envName = 'dev') {
  const dir = mkdtempSync(path.join(tmpdir(), 'open-estate-ingestion-'));
  try {
    cpSync(DEFAULT_CONFIG_DIR, dir, { recursive: true });
    writeFileSync(path.join(dir, 'connectors.json'), JSON.stringify(connectors));
    const app = new App({
      context: { ...CDK_CONTEXT, 'aws:cdk:bundling-stacks': [], configDir: dir },
    });
    const config = resolveEnvironment(envName);
    const settings = resolvePlatformSettings((key) => app.node.tryGetContext(key));
    const data = new DataStack(app, 'Data', { environment: config, settings });
    const stack = new IngestionStack(app, 'Ingestion', {
      tables: { listings: data.listingsTable, deletionBlocklist: data.deletionBlocklistTable },
      configBucket: data.configBucket,
      connectors: connectorsFromConfigFiles(data.configFiles),
      removalPolicy: config.removalPolicy,
    });
    return { stack, template: Template.fromStack(stack) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

type Statement = { Action: string | string[]; Resource: unknown };
const actionsOf = (template: Template, policyPrefix: string): string[] =>
  Object.entries(template.findResources('AWS::IAM::Policy'))
    .filter(([id]) => id.startsWith(policyPrefix))
    .flatMap(
      ([, p]) =>
        (p as { Properties: { PolicyDocument: { Statement: Statement[] } } }).Properties
          .PolicyDocument.Statement,
    )
    .flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]));

describe('IngestionStack', () => {
  const { template } = synth(CONNECTORS);

  it('creates one schedule, state machine and Lambda per connector', () => {
    template.resourceCountIs('AWS::Scheduler::Schedule', 2);
    template.resourceCountIs('AWS::StepFunctions::StateMachine', 2);
    template.resourceCountIs('AWS::Lambda::Function', 2);
  });

  it('schedules from connectors.json; disabled connectors get a DISABLED schedule (Req 11.1)', () => {
    template.hasResourceProperties('AWS::Scheduler::Schedule', {
      ScheduleExpression: 'rate(1 hour)',
      State: 'ENABLED',
      Target: { Input: JSON.stringify({ connectorId: 'partner-db' }) },
    });
    template.hasResourceProperties('AWS::Scheduler::Schedule', {
      ScheduleExpression: 'cron(0 3 * * ? *)',
      State: 'DISABLED',
    });
  });

  it('sets execution and Lambda timeout to timeoutSeconds, default 300 (Req 5.7)', () => {
    const definitions = Object.values(
      template.findResources('AWS::StepFunctions::StateMachine'),
    ).map((r) => JSON.stringify((r as { Properties: unknown }).Properties));
    expect(definitions.some((d) => d.includes('\\"TimeoutSeconds\\":600'))).toBe(true);
    expect(definitions.some((d) => d.includes('\\"TimeoutSeconds\\":300'))).toBe(true);
    template.hasResourceProperties('AWS::Lambda::Function', {
      Timeout: 600,
      Runtime: 'nodejs22.x',
      Environment: { Variables: { [CONNECTOR_LAMBDA_ENV.connectorId]: 'partner-db' } },
    });
    template.hasResourceProperties('AWS::Lambda::Function', {
      Timeout: 300,
      Environment: { Variables: { [CONNECTOR_LAMBDA_ENV.connectorId]: 'partner-site' } },
    });
  });

  it('grants the atomic upsert and config reads, secrets only to the owning connector', () => {
    const db = actionsOf(template, 'ConnectorpartnerdbFunction');
    const site = actionsOf(template, 'ConnectorpartnersiteFunction');
    for (const actions of [db, site]) {
      expect(actions).toEqual(
        expect.arrayContaining([
          'dynamodb:PutItem',
          'dynamodb:ConditionCheckItem',
          'dynamodb:GetItem',
          's3:GetObject',
          's3:ListBucket',
        ]),
      );
      expect(actions).not.toContain('dynamodb:Scan');
    }
    expect(db).toContain('secretsmanager:GetSecretValue');
    expect(site).not.toContain('secretsmanager:GetSecretValue');
    expect(actionsOf(template, 'SchedulerRole')).toEqual(['states:StartExecution']);
  });

  it('tags the resources of a connector with its id', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Tags: [{ Key: CONNECTOR_TAG, Value: 'partner-db' }],
    });
  });

  it('creates no connector resources without connectors', () => {
    const empty = synth([]).template;
    empty.resourceCountIs('AWS::Lambda::Function', 0);
    empty.resourceCountIs('AWS::Scheduler::Schedule', 0);
  });

  it('rejects connectors that bypass connectors.json validation', () => {
    const app = new App({ context: { 'aws:cdk:bundling-stacks': [] } });
    const data = new DataStack(app, 'Data', { environment: resolveEnvironment('dev') });
    const props = {
      tables: { listings: data.listingsTable, deletionBlocklist: data.deletionBlocklistTable },
      configBucket: data.configBucket,
      removalPolicy: resolveEnvironment('dev').removalPolicy,
    };
    const tooLong = [{ ...CONNECTORS[1], timeoutSeconds: 901 }] as unknown as ConnectorsFile;
    expect(() => new IngestionStack(app, 'Ingestion', { ...props, connectors: tooLong })).toThrow(
      /timeoutSeconds/,
    );
  });
});

/**
 * Task 10.16 (Req 5.7, 9.2): per-connector wiring and the structural half of "a timeout ends
 * only the affected connector". What a template can prove: every connector owns its function,
 * state machine, schedule, roles and log groups, with its own timeout; nothing (state machine,
 * function, reserved concurrency, IAM grant) is shared or reaches across connectors. A timeout
 * fires on one function or one execution, so it cannot stop another connector's run. Not
 * provable here: the account-wide Lambda concurrency pool (an AWS quota, not in the template).
 */
describe('IngestionStack per-connector isolation (task 10.16)', () => {
  const API_SECRET_ARN =
    'arn:aws:secretsmanager:eu-central-1:111122223333:secret:open-estate/partner-api-AbC123';
  const ISOLATION_CONNECTORS = [
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
    {
      id: 'partner-api',
      type: 'external-api',
      module: 'external-api',
      enabled: true,
      schedule: 'cron(15 2 * * ? *)',
      timeoutSeconds: 120,
      settings: {},
      secretRef: API_SECRET_ARN,
    },
    {
      id: 'partner-site',
      type: 'web-crawler',
      module: 'web-crawler',
      enabled: false,
      schedule: 'rate(1 day)',
      timeoutSeconds: 900,
      settings: {},
    },
  ] as const;

  const { template } = synth(ISOLATION_CONNECTORS);
  /** Env-agnostic like the synthesized stack, so resolved ARNs have the same shape. */
  const stack = new Stack(new App({ context: CDK_CONTEXT }), 'Arns');

  type Resource = { Type: string; Properties: Record<string, unknown> };
  const resources = template.toJSON()['Resources'] as Record<string, Resource>;

  /** Logical id of the single resource of `type` whose id starts with `prefix`. */
  function only(type: string, prefix: string): string {
    const ids = Object.keys(resources).filter(
      (id) => resources[id]?.Type === type && id.startsWith(prefix),
    );
    expect(ids).toHaveLength(1);
    return ids[0] ?? '';
  }

  const props = (id: string): Record<string, unknown> => resources[id]?.Properties ?? {};
  const statementsOf = (policyId: string): Statement[] =>
    (props(policyId)['PolicyDocument'] as { Statement: Statement[] }).Statement;

  /** State machine definition with CloudFormation tokens replaced by `<token:n>`. */
  function definitionOf(stateMachineId: string) {
    const join = props(stateMachineId)['DefinitionString'] as { 'Fn::Join': [string, unknown[]] };
    const tokens: unknown[] = [];
    const text = join['Fn::Join'][1]
      .map((part) => (typeof part === 'string' ? part : `<token:${tokens.push(part) - 1}>`))
      .join('');
    return { definition: JSON.parse(text) as Record<string, unknown>, tokens };
  }

  const wiring = ISOLATION_CONNECTORS.map((config) => {
    const prefix = `Connector${config.id.replace(/[^A-Za-z0-9]/g, '')}`;
    return {
      config,
      fn: only('AWS::Lambda::Function', `${prefix}Function`),
      fnPolicy: only('AWS::IAM::Policy', `${prefix}FunctionServiceRoleDefaultPolicy`),
      stateMachine: only('AWS::StepFunctions::StateMachine', `${prefix}StateMachine`),
      smPolicy: only('AWS::IAM::Policy', `${prefix}StateMachineRoleDefaultPolicy`),
      schedule: only('AWS::Scheduler::Schedule', `${prefix}Schedule`),
    };
  });

  it('creates exactly one function, state machine and schedule per connector', () => {
    for (const type of [
      'AWS::Lambda::Function',
      'AWS::StepFunctions::StateMachine',
      'AWS::Scheduler::Schedule',
    ]) {
      template.resourceCountIs(type, ISOLATION_CONNECTORS.length);
    }
    // `only(...)` above asserted one resource of each kind per connector prefix.
    expect(new Set(wiring.map((w) => w.stateMachine)).size).toBe(ISOLATION_CONNECTORS.length);
    expect(new Set(wiring.map((w) => w.fn)).size).toBe(ISOLATION_CONNECTORS.length);
  });

  it.each(ISOLATION_CONNECTORS.map((c) => [c.id, c.timeoutSeconds]))(
    '%s: execution timeout and Lambda timeout are both %i s (Req 5.7)',
    (connectorId) => {
      const w = wiring.find((x) => x.config.id === connectorId);
      if (!w) throw new Error('fixture');
      expect(definitionOf(w.stateMachine).definition['TimeoutSeconds']).toBe(
        w.config.timeoutSeconds,
      );
      expect(props(w.fn)['Timeout']).toBe(w.config.timeoutSeconds);
    },
  );

  it('each state machine invokes only its own function and fails on status FAILURE', () => {
    for (const w of wiring) {
      const { definition, tokens } = definitionOf(w.stateMachine);
      const states = definition['States'] as Record<string, Record<string, unknown>>;
      expect(states['RunConnector']).toMatchObject({
        Type: 'Task',
        Parameters: { connectorId: w.config.id, 'runId.$': '$$.Execution.Name' },
      });
      expect(tokens).toEqual([{ 'Fn::GetAtt': [w.fn, 'Arn'] }]);
      expect(states['RunStatus']).toMatchObject({
        Type: 'Choice',
        Choices: [{ Variable: '$.status', StringEquals: 'FAILURE', Next: 'RunFailed' }],
      });
      expect(states['RunFailed']).toMatchObject({ Type: 'Fail', Error: 'ConnectorRunFailed' });

      // The execution role may invoke this connector's function and nothing else.
      const invoke = statementsOf(w.smPolicy).filter((s) =>
        [s.Action].flat().includes('lambda:InvokeFunction'),
      );
      expect(JSON.stringify(invoke)).not.toMatch(
        new RegExp(
          wiring
            .filter((o) => o !== w)
            .map((o) => o.fn)
            .join('|'),
        ),
      );
      expect(invoke).toEqual([
        expect.objectContaining({
          Resource: [
            { 'Fn::GetAtt': [w.fn, 'Arn'] },
            { 'Fn::Join': ['', [{ 'Fn::GetAtt': [w.fn, 'Arn'] }, ':*']] },
          ],
        }),
      ]);
    }
  });

  it('each schedule starts its own state machine in UTC with input {connectorId}', () => {
    for (const w of wiring) {
      expect(props(w.schedule)).toMatchObject({
        ScheduleExpression: w.config.schedule,
        ScheduleExpressionTimezone: 'UTC',
        FlexibleTimeWindow: { Mode: 'OFF' },
        State: w.config.enabled ? 'ENABLED' : 'DISABLED',
        Target: {
          Arn: { Ref: w.stateMachine },
          Input: JSON.stringify({ connectorId: w.config.id }),
          RoleArn: { 'Fn::GetAtt': [expect.stringMatching(/^SchedulerRole/), 'Arn'] },
        },
      });
    }
  });

  it('lets the scheduler role start exactly the connector state machines, same account only', () => {
    const role = only('AWS::IAM::Role', 'SchedulerRole');
    expect(props(role)['AssumeRolePolicyDocument']).toMatchObject({
      Statement: [
        {
          Principal: { Service: 'scheduler.amazonaws.com' },
          Condition: { StringEquals: { 'aws:SourceAccount': { Ref: 'AWS::AccountId' } } },
        },
      ],
    });
    const statements = statementsOf(only('AWS::IAM::Policy', 'SchedulerRoleDefaultPolicy'));
    expect(statements.flatMap((s) => [s.Action].flat())).toEqual(
      statements.map(() => 'states:StartExecution'),
    );
    const targets = statements.flatMap((s) => [s.Resource].flat());
    expect(targets).toHaveLength(wiring.length);
    expect(targets).toEqual(expect.arrayContaining(wiring.map((w) => ({ Ref: w.stateMachine }))));
  });

  it('grants each function only its own secret, nothing on *, no cross-connector access', () => {
    const secretArnOf = (secretRef: string | undefined) =>
      secretRef === undefined ? undefined : stack.resolve(secretResourceArn(stack, secretRef));
    for (const w of wiring) {
      const statements = statementsOf(w.fnPolicy);
      expect(statements.flatMap((s) => [s.Resource].flat())).not.toContain('*');
      const secretStatements = statements.filter((s) =>
        [s.Action].flat().some((a) => a.startsWith('secretsmanager:')),
      );
      const own = secretArnOf('secretRef' in w.config ? w.config.secretRef : undefined);
      expect(secretStatements).toEqual(
        own === undefined
          ? []
          : [expect.objectContaining({ Action: 'secretsmanager:GetSecretValue', Resource: own })],
      );
      // Neither another connector's secret nor any of its resources appear in this policy.
      const policy = JSON.stringify(statements);
      for (const other of wiring.filter((o) => o !== w)) {
        if ('secretRef' in other.config) expect(policy).not.toContain(other.config.secretRef);
        expect(policy).not.toContain(other.fn);
        expect(policy).not.toContain(other.stateMachine);
      }
    }
  });

  it('shares no role, log group or concurrency setting between connectors', () => {
    const roles = wiring.map((w) => props(w.fn)['Role']);
    const smRoles = wiring.map((w) => props(w.stateMachine)['RoleArn']);
    const fnLogs = wiring.map((w) => props(w.fn)['LoggingConfig']);
    const smLogs = wiring.map((w) => props(w.stateMachine)['LoggingConfiguration']);
    for (const values of [roles, smRoles, fnLogs, smLogs]) {
      expect(new Set(values.map((v) => JSON.stringify(v))).size).toBe(wiring.length);
    }
    for (const w of wiring) {
      // No reserved/provisioned concurrency that could throttle one connector because of another.
      expect(props(w.fn)).not.toHaveProperty('ReservedConcurrentExecutions');
      expect(props(w.fn)['Environment']).toMatchObject({
        Variables: { [CONNECTOR_LAMBDA_ENV.connectorId]: w.config.id },
      });
    }
    template.resourceCountIs('AWS::Lambda::Version', 0);
    template.resourceCountIs('AWS::Lambda::Alias', 0);
    template.resourceCountIs('AWS::Lambda::EventSourceMapping', 0);
  });

  it('points every function at the DataStack tables (Listings, DeletionBlocklist)', () => {
    // Key schema, PITR and the bySource GSI of both tables: stacks.test.ts (DataStack, Req 9.2).
    for (const w of wiring) {
      const statements = statementsOf(w.fnPolicy);
      const put = statements.find((s) => [s.Action].flat().includes('dynamodb:PutItem'));
      const check = statements.find((s) =>
        [s.Action].flat().includes('dynamodb:ConditionCheckItem'),
      );
      expect(JSON.stringify(put?.Resource)).toMatch(/GetAttListings[A-Z0-9]*Arn/);
      expect(JSON.stringify(check?.Resource)).toMatch(/GetAttDeletionBlocklist[A-Z0-9]*Arn/);
    }
  });
});

describe('secretResourceArn', () => {
  const stack = new Stack(new App({ context: CDK_CONTEXT }), 'S', {
    env: { account: '111122223333', region: 'eu-west-1' },
  });

  it.each([
    ['db/creds', 'arn:aws:secretsmanager:eu-west-1:111122223333:secret:db/creds-??????'],
    [
      'arn:aws:secretsmanager:eu-west-1:111122223333:secret:db/creds-AbC123',
      'arn:aws:secretsmanager:eu-west-1:111122223333:secret:db/creds-AbC123',
    ],
    [
      'arn:aws:secretsmanager:eu-west-1:111122223333:secret:db/creds',
      'arn:aws:secretsmanager:eu-west-1:111122223333:secret:db/creds-??????',
    ],
  ])('%s → %s', (ref, expected) => {
    expect(stack.resolve(secretResourceArn(stack, ref))).toBe(expected);
  });
});
