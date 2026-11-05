import {
  createLocationsHandler,
  LOCATIONS_CACHE_CONTROL,
  type ListingsRequest,
} from '@open-estate/api';
import {
  createAccessGuard,
  createLocationService,
  InMemoryApiKeyStore,
  InMemoryRateLimitCounterStore,
  InMemorySearchProvider,
  ServiceUnavailableError,
  StaticAccessConfigSource,
  type AccessConfig,
} from '@open-estate/core';
import { DOC_LISTINGS } from './support/docs-examples';

const request: ListingsRequest = {
  httpMethod: 'GET',
  resource: '/locations',
  requestContext: { identity: { sourceIp: '203.0.113.7' } },
};

function setup(
  options: {
    mode?: AccessConfig['mode'];
    requests?: number;
    provider?: InMemorySearchProvider;
  } = {},
) {
  const provider = options.provider ?? new InMemorySearchProvider(DOC_LISTINGS);
  const guard = createAccessGuard({
    config: new StaticAccessConfigSource({
      mode: options.mode ?? 'open',
      rateLimit: { requests: options.requests ?? 60, windowSeconds: 60 },
    }),
    apiKeys: new InMemoryApiKeyStore([]),
    counters: new InMemoryRateLimitCounterStore(),
    clock: () => 0,
  });
  return createLocationsHandler({ guard, locations: createLocationService({ provider }) });
}

describe('GET /locations', () => {
  it('returns countries and cities with counts and a private 5-minute cache', async () => {
    const res = await setup()(request);
    expect(res.statusCode).toBe(200);
    expect(res.headers).toMatchObject({ 'Cache-Control': LOCATIONS_CACHE_CONTROL });
    expect(JSON.parse(res.body)).toEqual({
      countries: [{ code: 'DE', count: 3 }],
      cities: [
        { name: 'Berlin', country: 'DE', count: 2 },
        { name: 'Hamburg', country: 'DE', count: 1 },
      ],
    });
  });

  it('requires an API key in api-keys mode (401 API_KEY_MISSING)', async () => {
    const res = await setup({ mode: 'api-keys' })(request);
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).errors[0].code).toBe('API_KEY_MISSING');
  });

  it('counts against the rate limit (429 RATE_LIMITED)', async () => {
    const handler = setup({ requests: 1 });
    expect((await handler(request)).statusCode).toBe(200);
    const res = await handler(request);
    expect(res.statusCode).toBe(429);
    expect(res.headers).toHaveProperty('Retry-After');
  });

  it('answers 503 without details when the provider fails', async () => {
    const provider = new InMemorySearchProvider();
    jest.spyOn(provider, 'locations').mockRejectedValue(new ServiceUnavailableError('down'));
    const res = await setup({ provider })(request);
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body).errors).toEqual([
      expect.objectContaining({ code: 'SERVICE_UNAVAILABLE' }),
    ]);
  });
});
