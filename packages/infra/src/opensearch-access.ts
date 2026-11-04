import { Stack } from 'aws-cdk-lib';
import { PolicyStatement, type IRole } from 'aws-cdk-lib/aws-iam';
import { CfnAccessPolicy } from 'aws-cdk-lib/aws-opensearchserverless';
import type { IFunction } from 'aws-cdk-lib/aws-lambda';
import type { Construct } from 'constructs';

// OpenSearch Serverless access shared by the SearchStack (indexer) and the ApiStack (read side).
// A request needs both: IAM `aoss:APIAccessAll` on the collection and a data access policy that
// names the role. Each stack creates its own data access policy for its own roles, so the
// SearchStack never references roles of the ApiStack (which depends on it) — no cycle.

/** Index of the search documents; one per collection and environment. */
export const OPENSEARCH_INDEX_NAME = 'listings';

/**
 * Collection name of an environment (also the prefix of its policy names). AOSS allows
 * `[a-z][a-z0-9-]` with 3–32 characters; with the 16-character env names of `resolveEnvironment`
 * this leaves room for a 4-character policy suffix such as `-api`.
 */
export function searchCollectionName(envName: string): string {
  return `open-estate-${envName}`;
}

/** Index permissions of the indexer: create the index with its mapping (once), bulk write. */
export const INDEXER_INDEX_PERMISSIONS = [
  'aoss:CreateIndex',
  'aoss:DescribeIndex',
  'aoss:UpdateIndex',
  'aoss:WriteDocument',
] as const;

/** Index permissions of the read side (API and MCP Lambda): `_search` only. */
export const READER_INDEX_PERMISSIONS = ['aoss:DescribeIndex', 'aoss:ReadDocument'] as const;

/** A collection and index as seen by the stacks that access it. */
export interface SearchIndexRef {
  readonly collectionName: string;
  readonly collectionArn: string;
  readonly index: string;
}

/**
 * Data access policy granting `principals` the `permissions` on the one index of the collection.
 * `name` must be unique per account and region and follow the collection-name rules.
 */
export function addIndexAccessPolicy(
  scope: Construct,
  id: string,
  options: {
    readonly name: string;
    readonly target: Pick<SearchIndexRef, 'collectionName' | 'index'>;
    readonly principals: readonly IRole[];
    readonly permissions: readonly string[];
    readonly description: string;
  },
): CfnAccessPolicy {
  const { collectionName, index } = options.target;
  return new CfnAccessPolicy(scope, id, {
    name: options.name,
    type: 'data',
    description: options.description,
    policy: Stack.of(scope).toJsonString([
      {
        Rules: [
          {
            ResourceType: 'index',
            Resource: [`index/${collectionName}/${index}`],
            Permission: options.permissions,
          },
        ],
        Principal: options.principals.map((role) => role.roleArn),
      },
    ]),
  });
}

/** IAM side of the collection access: `aoss:APIAccessAll` on exactly this collection. */
export function grantCollectionApiAccess(fn: IFunction, collectionArn: string): void {
  fn.addToRolePolicy(
    new PolicyStatement({ actions: ['aoss:APIAccessAll'], resources: [collectionArn] }),
  );
}

/** The execution role of `fn`; every function here gets one created by CDK. */
export function roleOf(fn: IFunction): IRole {
  if (fn.role === undefined) throw new Error(`${fn.node.path} has no execution role`);
  return fn.role;
}
