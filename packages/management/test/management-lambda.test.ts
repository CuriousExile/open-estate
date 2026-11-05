import { GetParametersCommand, SSMClient } from '@aws-sdk/client-ssm';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { ConfigError } from '@open-estate/core';
import {
  createManagementHandlerFromEnv,
  definePublicRoute,
  initManagementHandler,
  MANAGEMENT_ENV,
  normalizeOrigin,
  ROUTE_GROUPS,
  success,
  type ManagementInitOptions,
  type RouteGroup,
} from '@open-estate/management';

const ENV = {
  USER_POOL_ID: 'eu-central-1_abc',
  USER_POOL_CLIENT_ID: 'client',
  MEMBERSHIPS_TABLE_NAME: 'Memberships',
  AGENCIES_TABLE_NAME: 'Agencies',
  MACHINE_ACCESS_TABLE_NAME: 'MachineAccess',
  AUDIT_LOG_TABLE_NAME: 'AuditLog',
  RATE_LIMIT_COUNTERS_TABLE_NAME: 'RateLimitCounters',
  MANAGEMENT_RATE_LIMIT_PARAMETER_NAME: '/oe/test/management-rate-limit',
  FRONTEND_ORIGIN_SSM_PARAMETER: '/oe/test/frontend-origin',
};

function clients(frontendOrigin: string | undefined) {
  const ssm = new SSMClient({ region: 'eu-central-1' });
  const ssmSend = jest.spyOn(ssm, 'send').mockImplementation(async (command: unknown) => {
    if (command instanceof GetParametersCommand) {
      return {
        Parameters:
          frontendOrigin === undefined
            ? []
            : [{ Name: ENV.FRONTEND_ORIGIN_SSM_PARAMETER, Value: frontendOrigin }],
      };
    }
    // GetParameter of the rate limit: not configured → default.
    throw Object.assign(new Error('missing'), { name: 'ParameterNotFound' });
  });
  const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'eu-central-1' }));
  jest.spyOn(dynamo, 'send').mockImplementation(async () => ({}));
  return { ssm, dynamo, ssmSend };
}

const options = (
  frontendOrigin: string | undefined,
  groups: readonly RouteGroup[] = [],
): ManagementInitOptions & { ssmSend: jest.SpyInstance } => {
  const { ssm, dynamo, ssmSend } = clients(frontendOrigin);
  return {
    clients: { ssm, dynamo },
    groups,
    tokenVerifier: { verify: async () => null },
    logger: { error: jest.fn() },
    ssmSend,
  };
};

const rejection = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
};

afterEach(() => jest.restoreAllMocks());

describe('initManagementHandler', () => {
  it('aborts the init if the frontend origin is missing', async () => {
    const error = await rejection(initManagementHandler(ENV, options(undefined)));
    expect(error).toBeInstanceOf(ConfigError);
    expect(error).toMatchObject({ code: 'CONFIG_MISSING', names: ['FRONTEND_ORIGIN'] });
  });

  it('aborts the init if the frontend origin is not an origin', async () => {
    const error = await rejection(
      initManagementHandler(ENV, options('https://portal.example.com/app')),
    );
    expect(error).toMatchObject({ code: 'CONFIG_INVALID', names: ['FRONTEND_ORIGIN'] });
  });

  it('names every missing environment variable', async () => {
    const error = await rejection(
      initManagementHandler(
        { ...ENV, USER_POOL_ID: ' ', AUDIT_LOG_TABLE_NAME: undefined },
        options('https://portal.example.com'),
      ),
    );
    expect(error).toMatchObject({
      code: 'CONFIG_MISSING',
      names: [MANAGEMENT_ENV.userPoolId, MANAGEMENT_ENV.auditLogTable],
    });
  });

  it('hands the validated frontend origin to the route groups', async () => {
    const seen: string[] = [];
    const group: RouteGroup = {
      name: 'test',
      create: ({ shared }) => {
        seen.push(shared.frontendOrigin);
        return [
          definePublicRoute({
            method: 'GET',
            path: '/openapi.json',
            handle: async () => success(200, { origin: shared.frontendOrigin }),
          }),
        ];
      },
    };
    const handler = await initManagementHandler(
      ENV,
      options('HTTPS://Portal.Example.com:443', [group]),
    );
    const response = await handler({
      httpMethod: 'GET',
      path: '/openapi.json',
      body: null,
      requestContext: { identity: { sourceIp: '192.0.2.1' } },
    });
    expect(seen).toEqual(['https://portal.example.com']);
    expect(JSON.parse(response.body)).toEqual({ origin: 'https://portal.example.com' });
  });
});

describe('createManagementHandlerFromEnv', () => {
  it('fails every invocation and logs the init failure once without values', async () => {
    const opts = options(undefined);
    const handler = createManagementHandlerFromEnv(ENV, opts);
    const event = {
      httpMethod: 'GET',
      path: '/me',
      body: null,
      requestContext: { identity: { sourceIp: '192.0.2.1' } },
    };
    await expect(handler(event)).rejects.toBeInstanceOf(ConfigError);
    await expect(handler(event)).rejects.toBeInstanceOf(ConfigError);
    expect(opts.logger?.error).toHaveBeenCalledTimes(1);
    expect(opts.logger?.error).toHaveBeenCalledWith('Management API: init failed', {
      errorName: 'ConfigError',
      code: 'CONFIG_MISSING',
      names: ['FRONTEND_ORIGIN'],
    });
  });
});

describe('route groups', () => {
  it('registers one placeholder group per route file', () => {
    expect(ROUTE_GROUPS.map((group) => group.name)).toEqual([
      'identity',
      'listings',
      'monitoring',
      'platform',
    ]);
  });
});

describe('normalizeOrigin', () => {
  it.each([
    ['https://portal.example.com', 'https://portal.example.com'],
    ['http://localhost:4200', 'http://localhost:4200'],
    ['https://portal.example.com/', undefined],
    ['ftp://portal.example.com', undefined],
    ['https://user@portal.example.com', undefined],
  ])('%s → %s', (input, expected) => {
    expect(normalizeOrigin(input)).toBe(expected);
  });
});
