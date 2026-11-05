import { GetCommand, ScanCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { EntityId, IsoDateTime, RoleSchema, type AgencyRole, type Role } from '@open-estate/shared';
import { z } from 'zod';
import {
  decodeKeyCursor,
  pageBySortKey,
  queryIndexPage,
  toKeyPage,
  type KeyPage,
  type KeyPageRequest,
} from './key-page';
import type { DynamoDbOp, InMemoryOp } from './transaction';

// `Memberships` table (design: "Data Models"): PK `userId` (Cognito `sub`); GSI `byAgency`
// (PK `agencyId`, SK `userId`, projection ALL). Plattform_Admins have no `agencyId` and are
// therefore not in the GSI. All writes are transaction operations, so the admin counters in
// `Agencies`/`PlatformCounters` change in the same `TransactWriteItems` (Req 1.7, 10.9).

export const MEMBERSHIPS_KEY_ATTRIBUTE = 'userId';
export const MEMBERSHIPS_BY_AGENCY_INDEX = 'byAgency';
export const MEMBERSHIPS_BY_AGENCY_PK_ATTRIBUTE = 'agencyId';
export const MEMBERSHIPS_BY_AGENCY_SK_ATTRIBUTE = 'userId';

/** Exactly one agency with an agency role, or `PLATFORM_ADMIN` without agency (Req 1.2). */
export const membershipRecordSchema = z
  .object({
    userId: EntityId,
    email: z.string(),
    displayName: z.string(),
    role: RoleSchema,
    agencyId: EntityId.optional(),
    createdAt: IsoDateTime,
  })
  .refine((record) => (record.role === 'PLATFORM_ADMIN') === (record.agencyId === undefined), {
    message: 'PLATFORM_ADMIN has no agency; agency roles require one',
  });

export type MembershipRecord = z.infer<typeof membershipRecordSchema>;

/** Expected current assignment; a write fails its condition if the stored one differs. */
export type MembershipAssignment =
  { role: AgencyRole; agencyId: string } | { role: 'PLATFORM_ADMIN'; agencyId?: undefined };

export interface MembershipStore<Op> {
  /** Strongly consistent; `null` = account without Platform access. */
  get(userId: string): Promise<MembershipRecord | null>;
  /** Members of an agency, ordered by `userId`. */
  listByAgency(agencyId: string, page: KeyPageRequest): Promise<KeyPage<MembershipRecord>>;
  /** Plattform_Admins, ordered by `userId` in the fake; DynamoDB: filtered scan (pages may be empty). */
  listPlatformAdmins(page: KeyPageRequest): Promise<KeyPage<MembershipRecord>>;
  /** Puts a membership iff the user has none (label `membership.create`, Req 1.2). */
  createOp(record: MembershipRecord): Op;
  /** Changes the agency role iff the stored assignment is `{from, agencyId}` (label `membership.role`). */
  changeRoleOp(userId: string, agencyId: string, from: AgencyRole, to: AgencyRole): Op;
  /** Deletes the membership iff the stored assignment equals `expected` (label `membership.delete`). */
  deleteOp(userId: string, expected: MembershipAssignment): Op;
}

/** Fake with transaction semantics via {@link InMemoryTransactor}. */
export class InMemoryMembershipStore implements MembershipStore<InMemoryOp> {
  private readonly memberships = new Map<string, MembershipRecord>();

  constructor(records: readonly MembershipRecord[] = []) {
    for (const record of records) {
      this.memberships.set(record.userId, membershipRecordSchema.parse(record));
    }
  }

  async get(userId: string): Promise<MembershipRecord | null> {
    const record = this.memberships.get(userId);
    return record === undefined ? null : { ...record };
  }

  async listByAgency(agencyId: string, page: KeyPageRequest): Promise<KeyPage<MembershipRecord>> {
    return this.page((record) => record.agencyId === agencyId, page);
  }

  async listPlatformAdmins(page: KeyPageRequest): Promise<KeyPage<MembershipRecord>> {
    return this.page((record) => record.role === 'PLATFORM_ADMIN', page);
  }

  createOp(record: MembershipRecord): InMemoryOp {
    const parsed = membershipRecordSchema.parse(record);
    return {
      label: 'membership.create',
      target: this.target(parsed.userId),
      check: () => !this.memberships.has(parsed.userId),
      apply: () => void this.memberships.set(parsed.userId, parsed),
    };
  }

  changeRoleOp(userId: string, agencyId: string, from: AgencyRole, to: AgencyRole): InMemoryOp {
    return {
      label: 'membership.role',
      target: this.target(userId),
      check: () => this.matches(userId, { role: from, agencyId }),
      apply: () => {
        const current = this.memberships.get(userId);
        if (current !== undefined) this.memberships.set(userId, { ...current, role: to });
      },
    };
  }

  deleteOp(userId: string, expected: MembershipAssignment): InMemoryOp {
    return {
      label: 'membership.delete',
      target: this.target(userId),
      check: () => this.matches(userId, expected),
      apply: () => void this.memberships.delete(userId),
    };
  }

  private matches(
    userId: string,
    expected: { role: Role; agencyId?: string | undefined },
  ): boolean {
    const current = this.memberships.get(userId);
    return (
      current !== undefined &&
      current.role === expected.role &&
      current.agencyId === expected.agencyId
    );
  }

  private target(userId: string): string {
    return `Memberships#${userId}`;
  }

  private page(
    predicate: (record: MembershipRecord) => boolean,
    page: KeyPageRequest,
  ): KeyPage<MembershipRecord> {
    const matching = [...this.memberships.values()].filter(predicate);
    const result = pageBySortKey(matching, (record) => record.userId, 'userId', page);
    return { ...result, items: result.items.map((record) => ({ ...record })) };
  }
}

export interface DynamoDbMembershipStoreOptions {
  client: DynamoDBDocumentClient;
  /** `Memberships` table. */
  tableName: string;
}

/** `Memberships` table; malformed items throw instead of granting access. */
export class DynamoDbMembershipStore implements MembershipStore<DynamoDbOp> {
  private readonly client: DynamoDBDocumentClient;
  private readonly tableName: string;

  constructor({ client, tableName }: DynamoDbMembershipStoreOptions) {
    this.client = client;
    this.tableName = tableName;
  }

  async get(userId: string): Promise<MembershipRecord | null> {
    const out = await this.client.send(
      new GetCommand({ TableName: this.tableName, Key: { userId }, ConsistentRead: true }),
    );
    return out.Item === undefined ? null : membershipRecordSchema.parse(out.Item);
  }

  async listByAgency(agencyId: string, page: KeyPageRequest): Promise<KeyPage<MembershipRecord>> {
    return queryIndexPage(
      this.client,
      {
        tableName: this.tableName,
        indexName: MEMBERSHIPS_BY_AGENCY_INDEX,
        partitionAttribute: MEMBERSHIPS_BY_AGENCY_PK_ATTRIBUTE,
        partitionValue: agencyId,
      },
      page,
      (item) => membershipRecordSchema.parse(item),
    );
  }

  /** Scan with filter: the table holds one item per user, Plattform_Admins are few. */
  async listPlatformAdmins({ limit, cursor }: KeyPageRequest): Promise<KeyPage<MembershipRecord>> {
    const out = await this.client.send(
      new ScanCommand({
        TableName: this.tableName,
        FilterExpression: '#role = :role',
        ExpressionAttributeNames: { '#role': 'role' },
        ExpressionAttributeValues: { ':role': 'PLATFORM_ADMIN' },
        Limit: limit,
        ConsistentRead: true,
        ...(cursor !== undefined && { ExclusiveStartKey: decodeKeyCursor(cursor) }),
      }),
    );
    return toKeyPage(out.Items, out.LastEvaluatedKey, (item) => membershipRecordSchema.parse(item));
  }

  createOp(record: MembershipRecord): DynamoDbOp {
    return {
      label: 'membership.create',
      item: {
        Put: {
          TableName: this.tableName,
          Item: membershipRecordSchema.parse(record),
          ConditionExpression: 'attribute_not_exists(#userId)',
          ExpressionAttributeNames: { '#userId': MEMBERSHIPS_KEY_ATTRIBUTE },
        },
      },
    };
  }

  changeRoleOp(userId: string, agencyId: string, from: AgencyRole, to: AgencyRole): DynamoDbOp {
    return {
      label: 'membership.role',
      item: {
        Update: {
          TableName: this.tableName,
          Key: { userId },
          UpdateExpression: 'SET #role = :to',
          ConditionExpression: '#role = :from AND #agencyId = :agencyId',
          ExpressionAttributeNames: { '#role': 'role', '#agencyId': 'agencyId' },
          ExpressionAttributeValues: { ':to': to, ':from': from, ':agencyId': agencyId },
        },
      },
    };
  }

  deleteOp(userId: string, expected: MembershipAssignment): DynamoDbOp {
    const agencyCondition =
      expected.agencyId === undefined
        ? { expression: 'attribute_not_exists(#agencyId)', values: {} }
        : { expression: '#agencyId = :agencyId', values: { ':agencyId': expected.agencyId } };
    return {
      label: 'membership.delete',
      item: {
        Delete: {
          TableName: this.tableName,
          Key: { userId },
          ConditionExpression: `#role = :role AND ${agencyCondition.expression}`,
          ExpressionAttributeNames: { '#role': 'role', '#agencyId': 'agencyId' },
          ExpressionAttributeValues: { ':role': expected.role, ...agencyCondition.values },
        },
      },
    };
  }
}
