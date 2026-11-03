import {
  API_RESPONSE_BUDGET_MS,
  createLogger,
  DEFAULT_METRICS_NAMESPACE,
  DOWNSTREAM_DEADLINE_MS,
  DYNAMODB_REQUEST_DEADLINE_MS,
  MCP_REQUEST_DEADLINE_MS,
  OPENSEARCH_REQUEST_DEADLINE_MS,
  REDACTED,
  redactLogValue,
  withRequestLatency,
} from '@open-estate/core';
import { PII_FIELD_PATHS } from '@open-estate/shared';
import { exampleListing } from '../../../shared/test/arbitraries/listing';
import { captureEmf } from './emf-capture';

const CONTACT = { name: 'Erika Mustermann', phone: '+49 30 1234567', email: 'erika@example.org' };
const SECRET_KEY = 'oe_live_0123456789abcdef';

afterEach(() => jest.restoreAllMocks());

describe('deadlines (Req 9.1, 9.6, 19.10)', () => {
  it('uses one downstream budget of 4.5 s below the 5-s response budget', () => {
    expect(DOWNSTREAM_DEADLINE_MS).toBe(4500);
    expect(DOWNSTREAM_DEADLINE_MS).toBeLessThan(API_RESPONSE_BUDGET_MS);
    expect(DYNAMODB_REQUEST_DEADLINE_MS).toBe(DOWNSTREAM_DEADLINE_MS);
    expect(OPENSEARCH_REQUEST_DEADLINE_MS).toBe(DOWNSTREAM_DEADLINE_MS);
  });

  it('keeps the MCP deadline at 10 s, above the downstream budget', () => {
    expect(MCP_REQUEST_DEADLINE_MS).toBe(10_000);
    expect(DOWNSTREAM_DEADLINE_MS).toBeLessThan(MCP_REQUEST_DEADLINE_MS);
  });
});

describe('redactLogValue (Req 18.2)', () => {
  it('redacts every PII field of a listing wherever it is nested', () => {
    const listing = exampleListing('home-1', { contact: CONTACT });
    const input = { listing, items: [{ contact: CONTACT }], contact: CONTACT };

    const out = JSON.stringify(redactLogValue(input));

    for (const value of Object.values(CONTACT)) expect(out).not.toContain(value);
    expect(out).toContain('home-1');
    expect(PII_FIELD_PATHS).toEqual(
      expect.arrayContaining(['contact.name', 'contact.phone', 'contact.email']),
    );
  });

  it('redacts credential headers case-insensitively, also as multi-value headers', () => {
    const out = redactLogValue({
      headers: { authorization: `Bearer ${SECRET_KEY}`, 'X-Api-Key': SECRET_KEY, Accept: '*/*' },
      multiValueHeaders: { Authorization: [`Bearer ${SECRET_KEY}`], Cookie: ['s=1'] },
      authorization: SECRET_KEY,
    });

    expect(out).toEqual({
      headers: { authorization: REDACTED, 'X-Api-Key': REDACTED, Accept: '*/*' },
      multiValueHeaders: { Authorization: REDACTED, Cookie: REDACTED },
      authorization: REDACTED,
    });
  });

  it('reduces errors to their name and cuts cycles without mutating the input', () => {
    const cyclic: Record<string, unknown> = { id: 'x' };
    cyclic['self'] = cyclic;
    const input = { error: new TypeError(`bad ${SECRET_KEY}`), cyclic };

    expect(redactLogValue(input)).toEqual({
      error: { name: 'TypeError' },
      cyclic: { id: 'x', self: REDACTED },
    });
    expect(cyclic['self']).toBe(cyclic);
  });

  it('keeps non-PII fields named like a PII leaf', () => {
    expect(redactLogValue({ tool: { name: 'search_listings' }, errorName: 'X' })).toEqual({
      tool: { name: 'search_listings' },
      errorName: 'X',
    });
  });
});

describe('createLogger', () => {
  function capture() {
    const lines: string[] = [];
    const record = (chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    };
    jest.spyOn(process.stdout, 'write').mockImplementation(record);
    jest.spyOn(process.stderr, 'write').mockImplementation(record);
    return lines;
  }

  it('writes structured JSON without any PII, credential or error message', () => {
    const lines = capture();
    const logger = createLogger('open-estate-test', { POWERTOOLS_LOG_LEVEL: 'INFO' });
    const listing = exampleListing('home-2', { contact: CONTACT });
    const event = {
      resource: '/listings',
      headers: { Authorization: `Bearer ${SECRET_KEY}` },
      multiValueHeaders: { authorization: [`Bearer ${SECRET_KEY}`] },
    };

    logger.info('request', { event, listing });
    logger.error('request failed', {
      error: new Error(`downstream ${SECRET_KEY}`),
      contact: CONTACT,
    });
    logger.appendKeys({ authorization: SECRET_KEY });
    logger.warn('with persistent key');

    const output = lines.join('');
    expect(lines).toHaveLength(3);
    for (const value of [...Object.values(CONTACT), SECRET_KEY]) {
      expect(output).not.toContain(value);
    }
    const [info, error] = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(info).toMatchObject({
      level: 'INFO',
      message: 'request',
      service: 'open-estate-test',
      event: { resource: '/listings', headers: { Authorization: REDACTED } },
      listing: { id: 'home-2', contact: { name: REDACTED, phone: REDACTED, email: REDACTED } },
    });
    expect(error).toMatchObject({ level: 'ERROR', error: { name: 'Error' } });
  });

  it('takes the service name from POWERTOOLS_SERVICE_NAME', () => {
    const lines = capture();
    createLogger('fallback', {
      POWERTOOLS_LOG_LEVEL: 'INFO',
      POWERTOOLS_SERVICE_NAME: 'configured',
    }).info('x');
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ service: 'configured' });
  });
});

describe('withRequestLatency (Req 11.4)', () => {
  it('emits RequestLatency in ms with exactly interface and endpoint as dimensions', async () => {
    const { metrics, points } = captureEmf();
    let t = 100;
    const handler = withRequestLatency(
      async (event: { path: string }) => {
        t += 42;
        return event.path;
      },
      { metrics, interface: 'api', endpoint: () => 'search', now: () => t },
    );

    expect(await handler({ path: '/listings' })).toBe('/listings');

    expect(points()).toEqual([
      {
        namespace: 'OpenEstateTest',
        dimensionSets: [['interface', 'endpoint']],
        interface: 'api',
        endpoint: 'search',
        latencyMs: 42,
        unit: 'Milliseconds',
      },
    ]);
  });

  it('records the latency of a failing request and rethrows', async () => {
    const { metrics, points } = captureEmf();
    const failure = new Error('boom');
    const handler = withRequestLatency(() => Promise.reject(failure), {
      metrics,
      interface: 'mcp',
      endpoint: () => 'get_listing',
    });

    await expect(handler(undefined)).rejects.toBe(failure);
    expect(points()).toEqual([
      expect.objectContaining({ interface: 'mcp', endpoint: 'get_listing' }),
    ]);
  });

  it('flushes one EMF line per request', async () => {
    const { metrics, points } = captureEmf();
    const handler = withRequestLatency(async (endpoint: string) => endpoint, {
      metrics,
      interface: 'api',
      endpoint: (e) => e,
    });

    await Promise.all([handler('search'), handler('detail')]);

    expect(points().map((p) => p.endpoint)).toEqual(['search', 'detail']);
  });

  it('uses the default namespace without POWERTOOLS_METRICS_NAMESPACE', async () => {
    const { metrics, points } = captureEmf({});
    await withRequestLatency(async () => undefined, {
      metrics,
      interface: 'api',
      endpoint: () => 'meta',
    })(undefined);

    expect(points()).toEqual([expect.objectContaining({ namespace: DEFAULT_METRICS_NAMESPACE })]);
  });
});
