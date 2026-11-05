import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  DynamoDbAgencyStore,
  DynamoDbMachineAccessStore,
  DynamoDbMembershipStore,
  DynamoDbPlatformCounterStore,
  encodeKeyCursor,
} from '@open-estate/core';

const documentClient = () =>
  DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'eu-central-1' }));

const conditionFailed = () =>
  new ConditionalCheckFailedException({ message: 'failed', $metadata: {} });

const CREATED = '2026-01-01T00:00:00Z';
const agency = {
  agencyId: 'a1',
  displayName: 'Agency',
  state: 'ACTIVE' as const,
  createdAt: CREATED,
  agencyAdmins: 1,
};

function mockSend(result: unknown = {}) {
  const client = documentClient();
  const send = jest.spyOn(client, 'send').mockImplementation(async () => result);
  const input = (index = 0) => (send.mock.calls[index]?.[0] as { input: unknown }).input;
  return { client, send, input };
}

describe('DynamoDbAgencyStore', () => {
  it('reads strongly consistent and parses the item', async () => {
    const { client, send, input } = mockSend({ Item: agency });
    const store = new DynamoDbAgencyStore({ client, tableName: 'Agencies' });
    await expect(store.get('a1')).resolves.toEqual(agency);
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(GetCommand);
    expect(input()).toEqual({
      TableName: 'Agencies',
      Key: { agencyId: 'a1' },
      ConsistentRead: true,
    });
  });

  it('returns null for unknown and throws for malformed items', async () => {
    const empty = mockSend({});
    await expect(
      new DynamoDbAgencyStore({ client: empty.client, tableName: 't' }).get('x'),
    ).resolves.toBeNull();
    const malformed = mockSend({ Item: { agencyId: 'a1', state: 'GONE' } });
    await expect(
      new DynamoDbAgencyStore({ client: malformed.client, tableName: 't' }).get('a1'),
    ).rejects.toThrow();
  });

  it('queries the byState index with cursor and returns the next cursor', async () => {
    const lastKey = { agencyId: 'a1', state: 'SUSPENDED' };
    const { client, send, input } = mockSend({ Items: [agency], LastEvaluatedKey: lastKey });
    const store = new DynamoDbAgencyStore({ client, tableName: 'Agencies' });
    const cursor = encodeKeyCursor({ agencyId: 'a0', state: 'SUSPENDED' });
    const page = await store.listByState('SUSPENDED', { limit: 25, cursor });
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(QueryCommand);
    expect(input()).toEqual({
      TableName: 'Agencies',
      IndexName: 'byState',
      KeyConditionExpression: '#pk = :pk',
      ExpressionAttributeNames: { '#pk': 'state' },
      ExpressionAttributeValues: { ':pk': 'SUSPENDED' },
      Limit: 25,
      ExclusiveStartKey: { agencyId: 'a0', state: 'SUSPENDED' },
    });
    expect(page).toEqual({ items: [agency], nextCursor: encodeKeyCursor(lastKey) });
  });

  it('creates with attribute_not_exists', async () => {
    const { client, send, input } = mockSend();
    await new DynamoDbAgencyStore({ client, tableName: 'Agencies' }).create(agency);
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(PutCommand);
    expect(input()).toEqual({
      TableName: 'Agencies',
      Item: agency,
      ConditionExpression: 'attribute_not_exists(#id)',
      ExpressionAttributeNames: { '#id': 'agencyId' },
    });
  });

  it('updates only given fields of an existing agency', async () => {
    const updated = { ...agency, state: 'SUSPENDED' };
    const { client, send, input } = mockSend({ Attributes: updated });
    const store = new DynamoDbAgencyStore({ client, tableName: 'Agencies' });
    await expect(store.update('a1', { state: 'SUSPENDED' })).resolves.toEqual(updated);
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(UpdateCommand);
    expect(input()).toEqual({
      TableName: 'Agencies',
      Key: { agencyId: 'a1' },
      UpdateExpression: 'SET #state = :state',
      ConditionExpression: 'attribute_exists(#id)',
      ExpressionAttributeNames: { '#id': 'agencyId', '#state': 'state' },
      ExpressionAttributeValues: { ':state': 'SUSPENDED' },
      ReturnValues: 'ALL_NEW',
    });
  });

  it('returns null when updating an unknown agency', async () => {
    const client = documentClient();
    jest.spyOn(client, 'send').mockImplementation(async () => {
      throw conditionFailed();
    });
    const store = new DynamoDbAgencyStore({ client, tableName: 'Agencies' });
    await expect(store.update('missing', { displayName: 'x' })).resolves.toBeNull();
  });

  it('builds existence and admin counter operations', () => {
    const store = new DynamoDbAgencyStore({ client: documentClient(), tableName: 'Agencies' });
    expect(store.existsOp('a1')).toEqual({
      label: 'agency.exists',
      item: {
        ConditionCheck: {
          TableName: 'Agencies',
          Key: { agencyId: 'a1' },
          ConditionExpression: 'attribute_exists(#id)',
          ExpressionAttributeNames: { '#id': 'agencyId' },
        },
      },
    });
    expect(store.adjustAdminsOp('a1', 1).item.Update).toEqual({
      TableName: 'Agencies',
      Key: { agencyId: 'a1' },
      UpdateExpression: 'ADD #admins :delta',
      ConditionExpression: 'attribute_exists(#id)',
      ExpressionAttributeNames: { '#admins': 'agencyAdmins', '#id': 'agencyId' },
      ExpressionAttributeValues: { ':delta': 1 },
    });
    expect(store.adjustAdminsOp('a1', -1)).toEqual({
      label: 'agency.admins',
      item: {
        Update: {
          TableName: 'Agencies',
          Key: { agencyId: 'a1' },
          UpdateExpression: 'ADD #admins :delta',
          ConditionExpression: '#admins > :one',
          ExpressionAttributeNames: { '#admins': 'agencyAdmins' },
          ExpressionAttributeValues: { ':delta': -1, ':one': 1 },
        },
      },
    });
  });
});

describe('DynamoDbMembershipStore', () => {
  const membership = {
    userId: 'u1',
    email: 'u1@example.test',
    displayName: 'User',
    role: 'AGENCY_ADMIN' as const,
    agencyId: 'a1',
    createdAt: CREATED,
  };

  it('reads by userId and queries the byAgency index', async () => {
    const { client, input } = mockSend({ Item: membership, Items: [membership] });
    const store = new DynamoDbMembershipStore({ client, tableName: 'Memberships' });
    await expect(store.get('u1')).resolves.toEqual(membership);
    expect(input(0)).toEqual({
      TableName: 'Memberships',
      Key: { userId: 'u1' },
      ConsistentRead: true,
    });
    await expect(store.listByAgency('a1', { limit: 10 })).resolves.toEqual({ items: [membership] });
    expect(input(1)).toMatchObject({
      IndexName: 'byAgency',
      ExpressionAttributeNames: { '#pk': 'agencyId' },
      ExpressionAttributeValues: { ':pk': 'a1' },
      Limit: 10,
    });
  });

  it('scans for platform admins', async () => {
    const admin = {
      userId: 'p1',
      email: 'p1@example.test',
      displayName: 'Admin',
      role: 'PLATFORM_ADMIN',
      createdAt: CREATED,
    };
    const { client, send, input } = mockSend({ Items: [admin] });
    const store = new DynamoDbMembershipStore({ client, tableName: 'Memberships' });
    await expect(store.listPlatformAdmins({ limit: 5 })).resolves.toEqual({ items: [admin] });
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(ScanCommand);
    expect(input()).toEqual({
      TableName: 'Memberships',
      FilterExpression: '#role = :role',
      ExpressionAttributeNames: { '#role': 'role' },
      ExpressionAttributeValues: { ':role': 'PLATFORM_ADMIN' },
      Limit: 5,
      ConsistentRead: true,
    });
  });

  it('builds conditional transaction operations', () => {
    const store = new DynamoDbMembershipStore({
      client: documentClient(),
      tableName: 'Memberships',
    });
    expect(store.createOp(membership)).toEqual({
      label: 'membership.create',
      item: {
        Put: {
          TableName: 'Memberships',
          Item: membership,
          ConditionExpression: 'attribute_not_exists(#userId)',
          ExpressionAttributeNames: { '#userId': 'userId' },
        },
      },
    });
    expect(store.changeRoleOp('u1', 'a1', 'AGENCY_ADMIN', 'AGENCY_MEMBER')).toEqual({
      label: 'membership.role',
      item: {
        Update: {
          TableName: 'Memberships',
          Key: { userId: 'u1' },
          UpdateExpression: 'SET #role = :to',
          ConditionExpression: '#role = :from AND #agencyId = :agencyId',
          ExpressionAttributeNames: { '#role': 'role', '#agencyId': 'agencyId' },
          ExpressionAttributeValues: {
            ':to': 'AGENCY_MEMBER',
            ':from': 'AGENCY_ADMIN',
            ':agencyId': 'a1',
          },
        },
      },
    });
    expect(
      store.deleteOp('u1', { role: 'AGENCY_MEMBER', agencyId: 'a1' }).item.Delete,
    ).toMatchObject({
      ConditionExpression: '#role = :role AND #agencyId = :agencyId',
      ExpressionAttributeValues: { ':role': 'AGENCY_MEMBER', ':agencyId': 'a1' },
    });
    expect(store.deleteOp('p1', { role: 'PLATFORM_ADMIN' }).item.Delete).toEqual({
      TableName: 'Memberships',
      Key: { userId: 'p1' },
      ConditionExpression: '#role = :role AND attribute_not_exists(#agencyId)',
      ExpressionAttributeNames: { '#role': 'role', '#agencyId': 'agencyId' },
      ExpressionAttributeValues: { ':role': 'PLATFORM_ADMIN' },
    });
  });

  it('rejects invalid memberships before building an operation', () => {
    const store = new DynamoDbMembershipStore({
      client: documentClient(),
      tableName: 'Memberships',
    });
    expect(() => store.createOp({ ...membership, role: 'PLATFORM_ADMIN' })).toThrow();
  });
});

describe('DynamoDbPlatformCounterStore', () => {
  it('reads the counter item, 0 if missing', async () => {
    const { client, input } = mockSend({ Item: { counter: 'platform', platformAdmins: 2 } });
    const store = new DynamoDbPlatformCounterStore({ client, tableName: 'PlatformCounters' });
    await expect(store.platformAdmins()).resolves.toBe(2);
    expect(input()).toEqual({
      TableName: 'PlatformCounters',
      Key: { counter: 'platform' },
      ConsistentRead: true,
    });
    const empty = mockSend({});
    await expect(
      new DynamoDbPlatformCounterStore({ client: empty.client, tableName: 't' }).platformAdmins(),
    ).resolves.toBe(0);
  });

  it('increments unconditionally and decrements only above one', () => {
    const store = new DynamoDbPlatformCounterStore({
      client: documentClient(),
      tableName: 'PlatformCounters',
    });
    expect(store.adjustPlatformAdminsOp(1)).toEqual({
      label: 'platform.admins',
      item: {
        Update: {
          TableName: 'PlatformCounters',
          Key: { counter: 'platform' },
          UpdateExpression: 'ADD #admins :delta',
          ExpressionAttributeNames: { '#admins': 'platformAdmins' },
          ExpressionAttributeValues: { ':delta': 1 },
        },
      },
    });
    expect(store.adjustPlatformAdminsOp(-1).item.Update).toMatchObject({
      ConditionExpression: '#admins > :one',
      ExpressionAttributeValues: { ':delta': -1, ':one': 1 },
    });
  });
});

describe('DynamoDbMachineAccessStore', () => {
  const access = {
    keyId: 'k1',
    agencyId: 'a1',
    label: 'CRM',
    keyHash: 'hash',
    permissions: ['listing:read' as const],
    createdBy: 'u1',
    createdAt: CREATED,
  };
  const now = Date.parse('2026-02-01T10:00:00Z');

  it('reads, lists by agency and creates conditionally', async () => {
    const { client, input } = mockSend({ Item: access, Items: [access] });
    const store = new DynamoDbMachineAccessStore({ client, tableName: 'MachineAccess' });
    await expect(store.get('k1')).resolves.toEqual(access);
    expect(input(0)).toEqual({
      TableName: 'MachineAccess',
      Key: { keyId: 'k1' },
      ConsistentRead: true,
    });
    await expect(store.listByAgency('a1', { limit: 3 })).resolves.toEqual({ items: [access] });
    expect(input(1)).toMatchObject({
      IndexName: 'byAgency',
      ExpressionAttributeValues: { ':pk': 'a1' },
    });
    await store.create(access);
    expect(input(2)).toEqual({
      TableName: 'MachineAccess',
      Item: access,
      ConditionExpression: 'attribute_not_exists(#keyId)',
      ExpressionAttributeNames: { '#keyId': 'keyId' },
    });
  });

  it('never stores a record with an invalid permission', async () => {
    const { client, send } = mockSend();
    const store = new DynamoDbMachineAccessStore({ client, tableName: 'MachineAccess' });
    await expect(
      store.create({ ...access, permissions: ['root' as unknown as 'listing:read'] }),
    ).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  it('revokes idempotently via if_not_exists; null when unknown', async () => {
    const revoked = { ...access, revokedAt: '2026-02-01T00:00:00Z' };
    const { client, input } = mockSend({ Attributes: revoked });
    const store = new DynamoDbMachineAccessStore({ client, tableName: 'MachineAccess' });
    await expect(store.revoke('k1', '2026-02-01T00:00:00Z')).resolves.toEqual(revoked);
    expect(input()).toEqual({
      TableName: 'MachineAccess',
      Key: { keyId: 'k1' },
      UpdateExpression: 'SET #revokedAt = if_not_exists(#revokedAt, :revokedAt)',
      ConditionExpression: 'attribute_exists(#keyId)',
      ExpressionAttributeNames: { '#revokedAt': 'revokedAt', '#keyId': 'keyId' },
      ExpressionAttributeValues: { ':revokedAt': '2026-02-01T00:00:00Z' },
      ReturnValues: 'ALL_NEW',
    });

    const failing = documentClient();
    jest.spyOn(failing, 'send').mockImplementation(async () => {
      throw conditionFailed();
    });
    await expect(
      new DynamoDbMachineAccessStore({ client: failing, tableName: 't' }).revoke('x', CREATED),
    ).resolves.toBeNull();
  });

  it('touches lastUsedAt only if older than the interval', async () => {
    const { client, input } = mockSend();
    const store = new DynamoDbMachineAccessStore({ client, tableName: 'MachineAccess' });
    await expect(store.touchLastUsed('k1', now)).resolves.toBe(true);
    expect(input()).toEqual({
      TableName: 'MachineAccess',
      Key: { keyId: 'k1' },
      UpdateExpression: 'SET #lastUsedAt = :now',
      ConditionExpression:
        'attribute_exists(#keyId) AND (attribute_not_exists(#lastUsedAt) OR #lastUsedAt <= :threshold)',
      ExpressionAttributeNames: { '#lastUsedAt': 'lastUsedAt', '#keyId': 'keyId' },
      ExpressionAttributeValues: {
        ':now': '2026-02-01T10:00:00.000Z',
        ':threshold': '2026-02-01T09:59:00.000Z',
      },
    });

    const failing = documentClient();
    const send = jest.spyOn(failing, 'send').mockImplementation(async () => {
      throw conditionFailed();
    });
    const failingStore = new DynamoDbMachineAccessStore({ client: failing, tableName: 't' });
    await expect(failingStore.touchLastUsed('k1', now)).resolves.toBe(false);
    send.mockImplementation(async () => {
      throw new Error('throttled');
    });
    await expect(failingStore.touchLastUsed('k1', now)).rejects.toThrow('throttled');
  });
});
