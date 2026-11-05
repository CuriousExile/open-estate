import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import {
  ConfigError,
  DEFAULT_RATE_LIMIT,
  InMemoryRateLimitCounterStore,
  type Authenticator,
  type CounterIncrement,
} from '@open-estate/core';
import {
  actorClientId,
  createManagementAccessGuard,
  SsmRateLimitSource,
  StaticRateLimitSource,
} from '@open-estate/management';
import { err, ok, type Principal } from '@open-estate/shared';

const user: Principal = {
  kind: 'user',
  userId: 'u1',
  displayName: 'Ute',
  role: 'AGENCY_MEMBER',
  agencyId: 'a1',
};
const machine: Principal = {
  kind: 'machine',
  keyId: 'k1',
  label: 'CRM',
  agencyId: 'a1',
  permissions: ['listing:read'],
};

function setup(principal: Principal | null, requests = 2) {
  const calls: string[] = [];
  const counters = new InMemoryRateLimitCounterStore();
  const tryIncrement = counters.tryIncrement.bind(counters);
  jest.spyOn(counters, 'tryIncrement').mockImplementation(async (input: CounterIncrement) => {
    calls.push(`count ${input.counterKey.split('#')[0]}`);
    return tryIncrement(input);
  });
  const authenticator: Authenticator = {
    authenticate: jest.fn(async () => {
      calls.push('authenticate');
      return principal === null
        ? err({ code: 'AUTH_INVALID' as const, message: 'Authentication invalid' })
        : ok(principal);
    }),
  };
  const guard = createManagementAccessGuard({
    authenticator,
    rateLimit: new StaticRateLimitSource({ requests, windowSeconds: 60 }),
    counters,
    clock: () => 30_000,
  });
  return { guard, calls, authenticator, counters };
}

describe('ManagementAccessGuard', () => {
  it('applies IP limit → authentication → actor limit, in this order', async () => {
    const { guard, calls } = setup(user);
    const result = await guard.admit({ sourceIp: '192.0.2.1', authorization: 'Bearer t' });
    expect(result).toEqual(ok(user));
    expect(calls).toEqual(['count mgmt-ip:192.0.2.1', 'authenticate', 'count user:u1']);
  });

  it('uses mk:{keyId} for machine accesses', async () => {
    const { guard, calls } = setup(machine);
    await guard.admit({ sourceIp: '192.0.2.1', authorization: 'Bearer oem_k1_s' });
    expect(calls.at(-1)).toBe('count mk:k1');
    expect(actorClientId(user)).toBe('user:u1');
  });

  it('does not authenticate once the IP limit is exhausted', async () => {
    const { guard, authenticator } = setup(user, 1);
    await guard.admit({ sourceIp: '192.0.2.1', authorization: 'Bearer t' });
    const second = await guard.admit({ sourceIp: '192.0.2.1', authorization: 'Bearer t' });
    expect(second).toEqual(
      err({
        code: 'RATE_LIMITED',
        message: 'Rate limit of 1 requests per 60 s exceeded',
        details: { retryAfterSeconds: 30 },
      }),
    );
    expect(authenticator.authenticate).toHaveBeenCalledTimes(1);
  });

  it('limits each actor across source IPs', async () => {
    const { guard } = setup(user, 1);
    expect((await guard.admit({ sourceIp: '192.0.2.1' })).ok).toBe(true);
    const other = await guard.admit({ sourceIp: '192.0.2.2' });
    expect(other.ok === false && other.error.code).toBe('RATE_LIMITED');
  });

  it('returns authentication errors without counting an actor', async () => {
    const { guard, calls } = setup(null);
    const result = await guard.admit({ sourceIp: '192.0.2.1', authorization: 'Bearer bad' });
    expect(result.ok === false && result.error.code).toBe('AUTH_INVALID');
    expect(calls).toEqual(['count mgmt-ip:192.0.2.1', 'authenticate']);
  });
});

describe('SsmRateLimitSource', () => {
  const source = (send: jest.Mock) => {
    const client = new SSMClient({ region: 'eu-central-1' });
    jest.spyOn(client, 'send').mockImplementation(send);
    return new SsmRateLimitSource({ client, parameterName: '/oe/test/management-rate-limit' });
  };

  it('reads the limit from the parameter', async () => {
    const send = jest.fn<Promise<unknown>, [unknown]>(async () => ({
      Parameter: { Value: '{"requests":5,"windowSeconds":10}' },
    }));
    expect(await source(send).load()).toEqual({ requests: 5, windowSeconds: 10 });
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(GetParameterCommand);
  });

  it('falls back to the default when the parameter does not exist', async () => {
    const missing = Object.assign(new Error('missing'), { name: 'ParameterNotFound' });
    const send = jest.fn(async () => {
      throw missing;
    });
    expect(await source(send).load()).toEqual(DEFAULT_RATE_LIMIT);
  });

  it('rejects values outside the ranges of Req 17.1', async () => {
    const send = jest.fn(async () => ({
      Parameter: { Value: '{"requests":0,"windowSeconds":10}' },
    }));
    await expect(source(send).load()).rejects.toBeInstanceOf(ConfigError);
  });
});
