import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { DELETION_HISTORY_ENV } from '@open-estate/admin';
import { IDEMPOTENCY_KEYS_BY_LISTING } from '@open-estate/core';
import { App, RemovalPolicy, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { AttributeType, TableV2 } from 'aws-cdk-lib/aws-dynamodb';
import { Key } from 'aws-cdk-lib/aws-kms';
import { Bucket, BucketEncryption } from 'aws-cdk-lib/aws-s3';
import { AdminStack, type DeletionHistoryResources } from '../src/admin-stack';
import { DEFAULT_OBSERVABILITY_SETTINGS, resolveEnvironment } from '../src/config';
import { DataStack } from '../src/data-stack';

// Task 8.1: the deletion task removes versions, Custom_Id keys, counters and snapshots besides
// the listing (Req 9.2, 9.3). The stores belong to the ManagementStack (task 12.2); a stand-in
// stack provides them here.

const CDK_CONTEXT = (
  JSON.parse(readFileSync(path.join(__dirname, '../cdk.json'), 'utf8')) as {
    context: Record<string, unknown>;
  }
).context;

type Statement = { Action: string | string[]; Resource: unknown; Condition?: unknown };

function synth(withHistory: boolean) {
  const app = new App({ context: { ...CDK_CONTEXT, 'aws:cdk:bundling-stacks': [] } });
  const environment = resolveEnvironment('dev');
  const data = new DataStack(app, 'Data', { environment });
  const management = new Stack(app, 'Management');
  const table = (id: string, pk: string) =>
    new TableV2(management, id, { partitionKey: { name: pk, type: AttributeType.STRING } });
  const history: DeletionHistoryResources = {
    listingVersions: table('ListingVersions', 'listingId'),
    listingKeys: table('ListingKeys', 'customKey'),
    metricCounters: table('MetricCounters', 'scope'),
    duplicateIndex: table('DuplicateIndex', 'pk'),
    idempotencyKeys: table('IdempotencyKeys', 'key'),
    duplicateReports: table('DuplicateReports', 'reportId'),
    snapshotBucket: new Bucket(management, 'VersionSnapshots', {
      encryption: BucketEncryption.KMS,
      encryptionKey: new Key(management, 'SnapshotKey'),
      removalPolicy: RemovalPolicy.DESTROY,
    }),
  };
  const admin = new AdminStack(app, 'Admin', {
    tables: {
      listings: data.listingsTable,
      apiKeys: data.apiKeysTable,
      deletionRequests: data.deletionRequestsTable,
      deletionBlocklist: data.deletionBlocklistTable,
      auditLog: data.auditLogTable,
    },
    parameterNames: data.parameterNames,
    reloadableFunctions: [],
    stageName: environment.stageName,
    removalPolicy: environment.removalPolicy,
    observability: DEFAULT_OBSERVABILITY_SETTINGS,
    ...(withHistory && { history }),
  });
  const template = Template.fromStack(admin);
  const statements = Object.entries(template.findResources('AWS::IAM::Policy'))
    .filter(([id]) => id.startsWith('DeletionTaskFunction'))
    .flatMap(
      ([, p]) =>
        (p as { Properties: { PolicyDocument: { Statement: Statement[] } } }).Properties
          .PolicyDocument.Statement,
    );
  const fn = Object.values(template.findResources('AWS::Lambda::Function')).find((resource) =>
    JSON.stringify(resource).includes('Deletion workflow task'),
  ) as { Properties: { Environment: { Variables: Record<string, unknown> } } } | undefined;
  return { statements, variables: fn?.Properties.Environment.Variables ?? {} };
}

/** Statements on resources whose JSON mentions `logicalIdPart`. */
const on = (statements: Statement[], logicalIdPart: string) =>
  statements.filter((s) => JSON.stringify(s.Resource).includes(logicalIdPart));

const actions = (statements: Statement[]) => statements.flatMap((s) => [s.Action].flat()).sort();

describe('AdminStack deletion task with the version history (task 8.1)', () => {
  const { statements, variables } = synth(true);

  it('passes every history store to the deletion task', () => {
    expect(Object.keys(variables)).toEqual(
      expect.arrayContaining(Object.values(DELETION_HISTORY_ENV)),
    );
    expect(JSON.stringify(variables[DELETION_HISTORY_ENV.listingVersionsTable])).toContain(
      'ListingVersions',
    );
    expect(JSON.stringify(variables[DELETION_HISTORY_ENV.snapshotBucket])).toContain(
      'VersionSnapshots',
    );
    expect(JSON.stringify(variables[DELETION_HISTORY_ENV.duplicateIndexTable])).toContain(
      'DuplicateIndex',
    );
    expect(JSON.stringify(variables[DELETION_HISTORY_ENV.idempotencyKeysTable])).toContain(
      'IdempotencyKeys',
    );
    expect(JSON.stringify(variables[DELETION_HISTORY_ENV.duplicateReportsTable])).toContain(
      'DuplicateReports',
    );
  });

  it('may remove the duplicate data of a listing but not write any (duplicate-detection 12.3)', () => {
    expect(actions(on(statements, 'DuplicateIndex'))).toEqual([
      'dynamodb:BatchWriteItem',
      'dynamodb:DeleteItem',
      'dynamodb:Query',
    ]);
    expect(actions(on(statements, 'IdempotencyKeys'))).toEqual([
      'dynamodb:DeleteItem',
      'dynamodb:GetItem',
      'dynamodb:Query',
    ]);
    const query = on(statements, 'IdempotencyKeys').find((s) => s.Action === 'dynamodb:Query');
    expect(JSON.stringify(query?.Resource)).toContain(`/index/${IDEMPOTENCY_KEYS_BY_LISTING}`);
    // Treffer are read and deleted, never written.
    expect(actions(on(statements, 'DuplicateReports'))).toEqual([
      'dynamodb:DeleteItem',
      'dynamodb:GetItem',
    ]);
  });

  it('grants only the removal of versions, keys, counters and snapshots', () => {
    expect(actions(on(statements, 'ListingVersions'))).toEqual([
      'dynamodb:BatchWriteItem',
      'dynamodb:Query',
    ]);
    expect(actions(on(statements, 'ListingKeys'))).toEqual(['dynamodb:DeleteItem']);
    expect(actions(on(statements, 'MetricCounters'))).toEqual(['dynamodb:UpdateItem']);
    expect(actions(on(statements, 'DeletionBlocklist'))).toEqual([
      'dynamodb:PutItem',
      'dynamodb:UpdateItem',
    ]);
    const snapshots = on(statements, 'VersionSnapshots');
    expect(actions(snapshots)).toEqual(['s3:DeleteObject', 's3:ListBucket']);
    const list = snapshots.find((s) => s.Action === 's3:ListBucket');
    expect(list?.Condition).toEqual({ StringLike: { 's3:prefix': ['listings/*/*'] } });
    const del = snapshots.find((s) => s.Action === 's3:DeleteObject');
    expect(JSON.stringify(del?.Resource)).toContain('/listings/*/*');
    expect(JSON.stringify(statements)).not.toMatch(/s3:GetObject|s3:PutObject|dynamodb:Scan/);
  });
});

describe('AdminStack deletion task without the version history', () => {
  const { statements, variables } = synth(false);

  it('sets neither the variables nor the grants', () => {
    for (const name of Object.values(DELETION_HISTORY_ENV))
      expect(variables).not.toHaveProperty(name);
    expect(JSON.stringify(statements)).not.toMatch(/BatchWriteItem|s3:/);
  });
});
