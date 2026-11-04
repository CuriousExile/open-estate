import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import {
  ADMIN_ENV,
  createAdminHandlerFromEnv,
  DynamoDbAuditLog,
  readAdminEnv,
} from '@open-estate/admin';
import { ConfigError } from '@open-estate/core';

const ENV = {
  API_KEYS_TABLE_NAME: 'ApiKeys',
  AUDIT_LOG_TABLE_NAME: 'AuditLog',
  ACCESS_MODE_PARAMETER_NAME: '/oe/test/access-mode',
  RATE_LIMIT_PARAMETER_NAME: '/oe/test/rate-limit',
  LISTINGS_TABLE_NAME: 'Listings',
  DELETION_REQUESTS_TABLE_NAME: 'DeletionRequests',
  DELETION_BLOCKLIST_TABLE_NAME: 'DeletionBlocklist',
  DELETION_STATE_MACHINE_ARN: 'arn:aws:states:eu-central-1:1:stateMachine:Deletion',
};

const documentClient = () =>
  DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'eu-central-1' }));

describe('readAdminEnv', () => {
  it('reads all variables', () => {
    expect(readAdminEnv(ENV)).toEqual({
      apiKeysTable: 'ApiKeys',
      auditLogTable: 'AuditLog',
      accessModeParameter: '/oe/test/access-mode',
      rateLimitParameter: '/oe/test/rate-limit',
      listingsTable: 'Listings',
      deletionRequestsTable: 'DeletionRequests',
      deletionBlocklistTable: 'DeletionBlocklist',
      deletionStateMachineArn: 'arn:aws:states:eu-central-1:1:stateMachine:Deletion',
    });
  });

  it('names every missing or empty variable', () => {
    const error = (() => {
      try {
        readAdminEnv({ ...ENV, API_KEYS_TABLE_NAME: ' ', RATE_LIMIT_PARAMETER_NAME: undefined });
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(ConfigError);
    expect(error).toMatchObject({
      code: 'CONFIG_MISSING',
      names: [ADMIN_ENV.apiKeysTable, ADMIN_ENV.rateLimitParameter],
    });
  });
});

describe('createAdminHandlerFromEnv', () => {
  it('wires DynamoDB and SSM: global limit to SSM, audit to the AuditLog table', async () => {
    const dynamo = documentClient();
    const ssm = new SSMClient({ region: 'eu-central-1' });
    const dynamoSend = jest.spyOn(dynamo, 'send').mockImplementation(async () => ({}));
    const ssmSend = jest.spyOn(ssm, 'send').mockImplementation(async () => ({}));
    const handler = createAdminHandlerFromEnv(ENV, { dynamo, ssm });

    const res = await handler({
      httpMethod: 'PUT',
      path: '/admin/rate-limit',
      body: '{"requests":10,"windowSeconds":20}',
      requestContext: { identity: { userArn: 'arn:aws:iam::1:user/a' } },
    });

    expect(res.statusCode).toBe(200);
    expect((ssmSend.mock.calls[0]?.[0] as PutParameterCommand).input).toEqual({
      Name: '/oe/test/rate-limit',
      Value: '{"requests":10,"windowSeconds":20}',
      Type: 'String',
      Overwrite: true,
    });
    expect((dynamoSend.mock.calls[0]?.[0] as PutCommand).input).toMatchObject({
      TableName: 'AuditLog',
      Item: { category: 'access-config', action: 'rate-limit.set' },
    });
  });

  it('fails at init when configuration is missing', () => {
    expect(() => createAdminHandlerFromEnv({})).toThrow(ConfigError);
  });
});

describe('DynamoDbAuditLog', () => {
  it('puts one item keyed by category and time-ordered unique sort key', async () => {
    const client = documentClient();
    const send = jest.spyOn(client, 'send').mockImplementation(async () => ({}));
    const log = new DynamoDbAuditLog({ client, tableName: 'AuditLog', newId: () => 'id-1' });

    await log.append({
      type: 'access-config',
      action: 'api-key.revoked',
      actor: 'arn:aws:iam::1:user/a',
      at: '2026-01-01T12:00:00.000Z',
      details: { keyId: 'k-1' },
    });

    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(PutCommand);
    expect((command as PutCommand).input).toEqual({
      TableName: 'AuditLog',
      Item: {
        category: 'access-config',
        timestampId: '2026-01-01T12:00:00.000Z#id-1',
        action: 'api-key.revoked',
        actor: 'arn:aws:iam::1:user/a',
        at: '2026-01-01T12:00:00.000Z',
        details: { keyId: 'k-1' },
      },
    });
  });
});
