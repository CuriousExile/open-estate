import * as path from 'node:path';
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import type { ITableV2 } from 'aws-cdk-lib/aws-dynamodb';
import { StartingPosition } from 'aws-cdk-lib/aws-lambda';
import { DynamoEventSource, SqsDlq } from 'aws-cdk-lib/aws-lambda-event-sources';
import type { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { CfnCollection, CfnSecurityPolicy } from 'aws-cdk-lib/aws-opensearchserverless';
import { Queue, QueueEncryption } from 'aws-cdk-lib/aws-sqs';
import { OPENSEARCH_ENDPOINT_ENV, OPENSEARCH_INDEX_ENV } from '@open-estate/core';
import type { Construct } from 'constructs';
import { bundledFunction, type OpenSearchTarget } from './api-stack';
import {
  addIndexAccessPolicy,
  grantCollectionApiAccess,
  INDEXER_INDEX_PERMISSIONS,
  OPENSEARCH_INDEX_NAME,
  roleOf,
  searchCollectionName,
} from './opensearch-access';

// Same relative depth from `src/` (ts) and `dist/` (compiled js).
const REPO_ROOT = path.resolve(__dirname, '../../..');
const CORE_PACKAGE = path.join(REPO_ROOT, 'packages/core');

/**
 * Stream → indexer settings. Retries are bounded by count and record age, failed records are
 * isolated by bisecting and per-item failures (`batchItemFailures`); what still fails lands as
 * metadata (shard, sequence range) in the DLQ. One batch per shard at a time (no
 * parallelization), so an upsert and a later delete of the same id are applied in order.
 */
export const INDEXER_EVENT_SOURCE = {
  batchSize: 100,
  maxBatchingWindow: Duration.seconds(2),
  retryAttempts: 10,
  // DynamoDB Streams keep records for 24 h; older records cannot be retried anyway.
  maxRecordAge: Duration.days(1),
} as const;

export interface SearchStackProps extends StackProps {
  readonly envName: string;
  /** `Listings` with a NEW_AND_OLD_IMAGES stream (DataStack with searchProvider `opensearch`). */
  readonly listings: ITableV2;
  readonly removalPolicy: RemovalPolicy;
}

/**
 * Optional OpenSearch Serverless search index (design: "Indexierungs-Strategie", Req 11.3),
 * created with context `searchProvider=opensearch`: a SEARCH collection (AWS-owned key, public
 * endpoint — every request still needs SigV4 with IAM `aoss:APIAccessAll` plus a data access
 * policy), and the indexer Lambda that mirrors upserts and deletions from the `Listings` stream.
 * Read access of the API/MCP Lambdas is granted by the ApiStack itself ({@link OpenSearchTarget}).
 *
 * The stream starts with this deployment (TRIM_HORIZON reads it from its first record). Listings
 * that existed before must be re-written to reach the index, e.g. by re-seeding; an unchanged
 * `PutItem` emits no stream record. To remove the stack again, destroy it before switching the
 * DataStack back to `dynamodb`: the stream is exported to this stack.
 */
export class SearchStack extends Stack {
  readonly collection: CfnCollection;
  readonly indexer: NodejsFunction;
  readonly deadLetterQueue: Queue;
  /** What the ApiStack needs to query and to grant its own roles access. */
  readonly target: OpenSearchTarget;

  constructor(scope: Construct, id: string, props: SearchStackProps) {
    super(scope, id, props);
    const name = searchCollectionName(props.envName);
    const collectionResource = [`collection/${name}`];

    // Both must exist before the collection; CloudFormation rejects it otherwise.
    const encryption = new CfnSecurityPolicy(this, 'EncryptionPolicy', {
      name: `${name}-enc`,
      type: 'encryption',
      description: 'Open Estate search collection: AWS owned key',
      policy: JSON.stringify({
        Rules: [{ ResourceType: 'collection', Resource: collectionResource }],
        AWSOwnedKey: true,
      }),
    });
    const network = new CfnSecurityPolicy(this, 'NetworkPolicy', {
      name: `${name}-net`,
      type: 'network',
      description: 'Open Estate search collection: public endpoint, IAM-authorized only',
      policy: JSON.stringify([
        {
          Rules: [{ ResourceType: 'collection', Resource: collectionResource }],
          AllowFromPublic: true,
        },
      ]),
    });

    this.collection = new CfnCollection(this, 'Collection', {
      name,
      type: 'SEARCH',
      description: 'Open Estate listing search index',
      // Redundant replicas only where data is retained (prod-like); dev runs on half the OCUs.
      standbyReplicas: props.removalPolicy === RemovalPolicy.RETAIN ? 'ENABLED' : 'DISABLED',
    });
    this.collection.addResourceDependency(encryption);
    this.collection.addResourceDependency(network);
    this.collection.applyRemovalPolicy(props.removalPolicy);

    this.target = {
      endpoint: this.collection.attrCollectionEndpoint,
      index: OPENSEARCH_INDEX_NAME,
      collectionName: name,
      collectionArn: this.collection.attrArn,
    };

    this.indexer = bundledFunction(this, 'IndexerFunction', {
      description: 'Mirrors Listings stream upserts and deletions into OpenSearch',
      packageDir: CORE_PACKAGE,
      entry: 'src/indexer/handler.ts',
      memorySize: 512,
      timeout: Duration.seconds(60),
      removalPolicy: props.removalPolicy,
    });
    // AWS_REGION is set by the Lambda runtime.
    this.indexer.addEnvironment(OPENSEARCH_ENDPOINT_ENV, this.target.endpoint);
    this.indexer.addEnvironment(OPENSEARCH_INDEX_ENV, this.target.index);
    grantCollectionApiAccess(this.indexer, this.target.collectionArn);
    addIndexAccessPolicy(this, 'IndexerAccessPolicy', {
      name: `${name}-idx`,
      description: 'Indexer Lambda: create the listings index and write documents',
      target: this.target,
      principals: [roleOf(this.indexer)],
      permissions: INDEXER_INDEX_PERMISSIONS,
    });

    this.deadLetterQueue = new Queue(this, 'IndexerDeadLetterQueue', {
      encryption: QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
      removalPolicy: props.removalPolicy,
    });
    this.indexer.addEventSource(
      new DynamoEventSource(props.listings, {
        startingPosition: StartingPosition.TRIM_HORIZON,
        ...INDEXER_EVENT_SOURCE,
        bisectBatchOnError: true,
        reportBatchItemFailures: true,
        onFailure: new SqsDlq(this.deadLetterQueue),
      }),
    );

    new CfnOutput(this, 'CollectionEndpoint', {
      description: 'Endpoint of the OpenSearch Serverless collection',
      value: this.target.endpoint,
    });
    new CfnOutput(this, 'IndexerDeadLetterQueueUrl', {
      description: 'Stream batches the indexer gave up on (metadata only)',
      value: this.deadLetterQueue.queueUrl,
    });
  }
}
