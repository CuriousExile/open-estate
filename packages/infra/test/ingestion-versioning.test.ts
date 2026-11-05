import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { App, RemovalPolicy, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { AttributeType, TableV2 } from 'aws-cdk-lib/aws-dynamodb';
import { Key } from 'aws-cdk-lib/aws-kms';
import { Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import { DEFAULT_METRICS_NAMESPACE } from '@open-estate/core';
import { CONNECTOR_LAMBDA_ENV, type ConnectorsFile } from '@open-estate/ingestion';
import { resolveEnvironment } from '../src/config';
import { DataStack } from '../src/data-stack';
import { IngestionStack, type ConnectorVersioningResources } from '../src/ingestion-stack';

// Task 12.3: connector Lambdas write through the VersionedListingWriter (Req 7.1, 12) and share
// the EMF namespace of the platform metrics (Req 14.1). The versioning stores belong to the
// ManagementStack (task 12.2); a stand-in stack provides them here.

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
  },
] as unknown as ConnectorsFile;

type Statement = { Action: string | string[]; Resource: unknown };

function synth(withVersioning: boolean) {
  const app = new App({ context: { ...CDK_CONTEXT, 'aws:cdk:bundling-stacks': [] } });
  const environment = resolveEnvironment('dev');
  const data = new DataStack(app, 'Data', { environment });
  const management = new Stack(app, 'Management');
  const table = (id: string, pk: string) =>
    new TableV2(management, id, { partitionKey: { name: pk, type: AttributeType.STRING } });
  const versioning: ConnectorVersioningResources = {
    listingVersions: table('ListingVersions', 'listingId'),
    listingKeys: table('ListingKeys', 'key'),
    metricCounters: table('MetricCounters', 'scope'),
    connectorRuns: table('ConnectorRuns', 'connectorId'),
    runRejections: table('RunRejections', 'runId'),
    snapshotBucket: new Bucket(management, 'VersionSnapshots', {
      encryption: BucketEncryption.KMS,
      encryptionKey: new Key(management, 'SnapshotKey'),
      removalPolicy: RemovalPolicy.DESTROY,
    }),
  };
  const stack = new IngestionStack(app, 'Ingestion', {
    tables: { listings: data.listingsTable, deletionBlocklist: data.deletionBlocklistTable },
    configBucket: data.configBucket,
    connectors: CONNECTORS,
    removalPolicy: environment.removalPolicy,
    ...(withVersioning && { versioning }),
  });
  const template = Template.fromStack(stack);
  const statements = Object.entries(template.findResources('AWS::IAM::Policy'))
    // The connector function's role (the state machine role is covered by ingestion-stack.test).
    .filter(([id]) => id.startsWith('ConnectorpartnerdbFunction'))
    .flatMap(
      ([, p]) =>
        (p as { Properties: { PolicyDocument: { Statement: Statement[] } } }).Properties
          .PolicyDocument.Statement,
    );
  const [fn] = Object.values(template.findResources('AWS::Lambda::Function')) as {
    Properties: { Environment: { Variables: Record<string, unknown> } };
  }[];
  return { statements, variables: fn?.Properties.Environment.Variables ?? {} };
}

/** Actions granted on resources whose JSON mentions `logicalIdPart`. */
function actionsOn(statements: Statement[], logicalIdPart: string): string[] {
  return statements
    .filter((s) => JSON.stringify(s.Resource).includes(logicalIdPart))
    .flatMap((s) => [s.Action].flat())
    .sort();
}

describe('IngestionStack versioned write path (task 12.3)', () => {
  const { statements, variables } = synth(true);

  it('passes the versioning stores and the EMF namespace to the connector Lambda', () => {
    for (const name of [
      CONNECTOR_LAMBDA_ENV.listingsTable,
      CONNECTOR_LAMBDA_ENV.deletionBlocklistTable,
      CONNECTOR_LAMBDA_ENV.listingVersionsTable,
      CONNECTOR_LAMBDA_ENV.listingKeysTable,
      CONNECTOR_LAMBDA_ENV.metricCountersTable,
      CONNECTOR_LAMBDA_ENV.snapshotBucket,
      CONNECTOR_LAMBDA_ENV.connectorRunsTable,
      CONNECTOR_LAMBDA_ENV.runRejectionsTable,
    ]) {
      expect(variables[name]).toBeDefined();
    }
    expect(JSON.stringify(variables[CONNECTOR_LAMBDA_ENV.connectorRunsTable])).toMatch(
      /ConnectorRuns/,
    );
    expect(JSON.stringify(variables[CONNECTOR_LAMBDA_ENV.runRejectionsTable])).toMatch(
      /RunRejections/,
    );
    expect(JSON.stringify(variables[CONNECTOR_LAMBDA_ENV.listingVersionsTable])).toMatch(
      /ListingVersions/,
    );
    expect(JSON.stringify(variables[CONNECTOR_LAMBDA_ENV.snapshotBucket])).toMatch(
      /VersionSnapshots/,
    );
    expect(variables['POWERTOOLS_METRICS_NAMESPACE']).toBe(DEFAULT_METRICS_NAMESPACE);
  });

  it('grants exactly the transaction operations of the writer, per table', () => {
    expect(actionsOn(statements, 'GetAttListingVersions')).toEqual([
      'dynamodb:GetItem',
      'dynamodb:PutItem',
      'dynamodb:Query',
    ]);
    expect(actionsOn(statements, 'GetAttListingKeys')).toEqual([
      'dynamodb:DeleteItem',
      'dynamodb:GetItem',
      'dynamodb:PutItem',
    ]);
    expect(actionsOn(statements, 'GetAttMetricCounters')).toEqual(['dynamodb:UpdateItem']);
    expect(actionsOn(statements, 'GetAttListings')).toEqual([
      'dynamodb:PutItem',
      'dynamodb:UpdateItem',
    ]);
    // Blocklist check of listing ids and `custom#{agencyId}#{customId}` keys (Req 9.3).
    expect(actionsOn(statements, 'GetAttDeletionBlocklist')).toEqual([
      'dynamodb:ConditionCheckItem',
      'dynamodb:GetItem',
    ]);
  });

  it('may only put run summaries and rejections (no read, update or delete)', () => {
    for (const table of ['GetAttConnectorRuns', 'GetAttRunRejections']) {
      expect(actionsOn(statements, table)).toEqual(['dynamodb:BatchWriteItem', 'dynamodb:PutItem']);
    }
  });

  it('may only put snapshots under listings/, never delete them', () => {
    const snapshot = statements.filter((s) =>
      JSON.stringify(s.Resource).includes('VersionSnapshots'),
    );
    expect(snapshot.flatMap((s) => [s.Action].flat())).toEqual(
      expect.arrayContaining(['s3:PutObject']),
    );
    expect(JSON.stringify(snapshot)).not.toMatch(/s3:DeleteObject|s3:GetObject/);
    expect(JSON.stringify(snapshot.map((s) => s.Resource))).toContain('/listings/*/*.json');
    // SSE-KMS bucket: the grant includes encrypting with the snapshot key.
    expect(statements.flatMap((s) => [s.Action].flat())).toContain('kms:GenerateDataKey*');
  });

  it('grants no Scan, no PutMetricData (EMF goes through the log stream) and nothing on *', () => {
    const actions = statements.flatMap((s) => [s.Action].flat());
    expect(actions).not.toContain('dynamodb:Scan');
    expect(actions).not.toContain('cloudwatch:PutMetricData');
    expect(statements.flatMap((s) => [s.Resource].flat())).not.toContain('*');
  });
});

describe('IngestionStack without the versioning stores', () => {
  it('neither sets their variables nor grants access to them', () => {
    const { statements, variables } = synth(false);
    expect(variables).not.toHaveProperty(CONNECTOR_LAMBDA_ENV.listingVersionsTable);
    expect(variables).not.toHaveProperty(CONNECTOR_LAMBDA_ENV.snapshotBucket);
    expect(variables).not.toHaveProperty(CONNECTOR_LAMBDA_ENV.connectorRunsTable);
    expect(variables).not.toHaveProperty(CONNECTOR_LAMBDA_ENV.runRejectionsTable);
    expect(actionsOn(statements, 'GetAttListings')).toEqual(['dynamodb:PutItem']);
  });
});
