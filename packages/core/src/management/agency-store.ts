import {
  GetCommand,
  PutCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import {
  AgencyStateSchema,
  EntityId,
  IsoDateTime,
  MANAGEMENT_BOUNDS,
  type AgencyState,
} from '@open-estate/shared';
import { z } from 'zod';
import { pageBySortKey, queryIndexPage, type KeyPage, type KeyPageRequest } from './key-page';
import { isConditionalCheckFailed, type DynamoDbOp, type InMemoryOp } from './transaction';

// `Agencies` table (design: "Data Models"): PK `agencyId`; GSI `byState` (PK `state`, SK
// `agencyId`, projection ALL) for the set of suspended agencies and the agency overview.

export const AGENCIES_KEY_ATTRIBUTE = 'agencyId';
export const AGENCIES_BY_STATE_INDEX = 'byState';
export const AGENCIES_BY_STATE_PK_ATTRIBUTE = 'state';
export const AGENCIES_BY_STATE_SK_ATTRIBUTE = 'agencyId';

/** Agency with its `AGENCY_ADMIN` counter, kept exact by transactions (Req 1.1, 1.7). */
export const agencyRecordSchema = z.object({
  agencyId: EntityId,
  displayName: z
    .string()
    .min(MANAGEMENT_BOUNDS.agencyName.min)
    .max(MANAGEMENT_BOUNDS.agencyName.max),
  state: AgencyStateSchema,
  createdAt: IsoDateTime,
  agencyAdmins: z.int().min(0),
});

export type AgencyRecord = z.infer<typeof agencyRecordSchema>;

const agencyChangeSchema = agencyRecordSchema.pick({ displayName: true, state: true }).partial();

/** Validated change without unknown keys and without `undefined` values. */
function definedFields(change: AgencyChange): AgencyChange {
  return Object.fromEntries(
    Object.entries(agencyChangeSchema.parse(change)).filter(([, value]) => value !== undefined),
  );
}

export interface AgencyChange {
  displayName?: string;
  state?: AgencyState;
}

export interface AgencyStore<Op> {
  /** Strongly consistent; `null` if unknown. */
  get(agencyId: string): Promise<AgencyRecord | null>;
  /** Agencies in `state`, ordered by `agencyId`. */
  listByState(state: AgencyState, page: KeyPageRequest): Promise<KeyPage<AgencyRecord>>;
  /** Stores a new agency; throws if the id exists. */
  create(record: AgencyRecord): Promise<void>;
  /** Renames and/or sets the state; `null` if unknown. */
  update(agencyId: string, change: AgencyChange): Promise<AgencyRecord | null>;
  /** Condition: the agency exists (label `agency.exists`). */
  existsOp(agencyId: string): Op;
  /**
   * `agencyAdmins += delta` (label `agency.admins`). `+1` requires the agency to exist; `-1`
   * requires at least one remaining admin, i.e. `agencyAdmins > 1` (Req 1.7).
   */
  adjustAdminsOp(agencyId: string, delta: 1 | -1): Op;
}

/** Fake with transaction semantics via {@link InMemoryTransactor}. */
export class InMemoryAgencyStore implements AgencyStore<InMemoryOp> {
  private readonly agencies = new Map<string, AgencyRecord>();

  constructor(records: readonly AgencyRecord[] = []) {
    for (const record of records)
      this.agencies.set(record.agencyId, agencyRecordSchema.parse(record));
  }

  async get(agencyId: string): Promise<AgencyRecord | null> {
    const record = this.agencies.get(agencyId);
    return record === undefined ? null : { ...record };
  }

  async listByState(state: AgencyState, page: KeyPageRequest): Promise<KeyPage<AgencyRecord>> {
    const matching = [...this.agencies.values()].filter((record) => record.state === state);
    const result = pageBySortKey(matching, (record) => record.agencyId, 'agencyId', page);
    return { ...result, items: result.items.map((record) => ({ ...record })) };
  }

  async create(record: AgencyRecord): Promise<void> {
    if (this.agencies.has(record.agencyId)) {
      throw new Error(`Agency ${record.agencyId} already exists`);
    }
    this.agencies.set(record.agencyId, agencyRecordSchema.parse(record));
  }

  async update(agencyId: string, change: AgencyChange): Promise<AgencyRecord | null> {
    const current = this.agencies.get(agencyId);
    if (current === undefined) return null;
    const updated = agencyRecordSchema.parse({ ...current, ...definedFields(change) });
    this.agencies.set(agencyId, updated);
    return { ...updated };
  }

  existsOp(agencyId: string): InMemoryOp {
    return {
      label: 'agency.exists',
      target: `Agencies#${agencyId}`,
      check: () => this.agencies.has(agencyId),
      apply: () => undefined,
    };
  }

  adjustAdminsOp(agencyId: string, delta: 1 | -1): InMemoryOp {
    return {
      label: 'agency.admins',
      target: `Agencies#${agencyId}`,
      check: () => {
        const current = this.agencies.get(agencyId);
        return current !== undefined && (delta > 0 || current.agencyAdmins > 1);
      },
      apply: () => {
        const current = this.agencies.get(agencyId);
        if (current !== undefined) {
          this.agencies.set(agencyId, { ...current, agencyAdmins: current.agencyAdmins + delta });
        }
      },
    };
  }
}

export interface DynamoDbAgencyStoreOptions {
  client: DynamoDBDocumentClient;
  /** `Agencies` table. */
  tableName: string;
}

/** `Agencies` table; malformed items throw. Writes are conditional on (non-)existence. */
export class DynamoDbAgencyStore implements AgencyStore<DynamoDbOp> {
  private readonly client: DynamoDBDocumentClient;
  private readonly tableName: string;

  constructor({ client, tableName }: DynamoDbAgencyStoreOptions) {
    this.client = client;
    this.tableName = tableName;
  }

  async get(agencyId: string): Promise<AgencyRecord | null> {
    const out = await this.client.send(
      new GetCommand({ TableName: this.tableName, Key: { agencyId }, ConsistentRead: true }),
    );
    return out.Item === undefined ? null : agencyRecordSchema.parse(out.Item);
  }

  async listByState(state: AgencyState, page: KeyPageRequest): Promise<KeyPage<AgencyRecord>> {
    return queryIndexPage(
      this.client,
      {
        tableName: this.tableName,
        indexName: AGENCIES_BY_STATE_INDEX,
        partitionAttribute: AGENCIES_BY_STATE_PK_ATTRIBUTE,
        partitionValue: state,
      },
      page,
      (item) => agencyRecordSchema.parse(item),
    );
  }

  async create(record: AgencyRecord): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: agencyRecordSchema.parse(record),
        ConditionExpression: 'attribute_not_exists(#id)',
        ExpressionAttributeNames: { '#id': AGENCIES_KEY_ATTRIBUTE },
      }),
    );
  }

  async update(agencyId: string, change: AgencyChange): Promise<AgencyRecord | null> {
    const fields = Object.entries(definedFields(change));
    if (fields.length === 0) return this.get(agencyId);
    try {
      const out = await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { agencyId },
          // `state` is a DynamoDB reserved word, hence attribute name placeholders throughout.
          UpdateExpression: `SET ${fields.map(([name]) => `#${name} = :${name}`).join(', ')}`,
          ConditionExpression: 'attribute_exists(#id)',
          ExpressionAttributeNames: {
            '#id': AGENCIES_KEY_ATTRIBUTE,
            ...Object.fromEntries(fields.map(([name]) => [`#${name}`, name])),
          },
          ExpressionAttributeValues: Object.fromEntries(
            fields.map(([name, value]) => [`:${name}`, value]),
          ),
          ReturnValues: 'ALL_NEW',
        }),
      );
      return agencyRecordSchema.parse(out.Attributes);
    } catch (error) {
      if (isConditionalCheckFailed(error)) return null;
      throw error;
    }
  }

  existsOp(agencyId: string): DynamoDbOp {
    return {
      label: 'agency.exists',
      item: {
        ConditionCheck: {
          TableName: this.tableName,
          Key: { agencyId },
          ConditionExpression: 'attribute_exists(#id)',
          ExpressionAttributeNames: { '#id': AGENCIES_KEY_ATTRIBUTE },
        },
      },
    };
  }

  adjustAdminsOp(agencyId: string, delta: 1 | -1): DynamoDbOp {
    return {
      label: 'agency.admins',
      item: {
        Update: {
          TableName: this.tableName,
          Key: { agencyId },
          UpdateExpression: 'ADD #admins :delta',
          ...(delta > 0
            ? {
                ConditionExpression: 'attribute_exists(#id)',
                ExpressionAttributeNames: {
                  '#admins': 'agencyAdmins',
                  '#id': AGENCIES_KEY_ATTRIBUTE,
                },
                ExpressionAttributeValues: { ':delta': delta },
              }
            : {
                ConditionExpression: '#admins > :one',
                ExpressionAttributeNames: { '#admins': 'agencyAdmins' },
                ExpressionAttributeValues: { ':delta': delta, ':one': 1 },
              }),
        },
      },
    };
  }
}
