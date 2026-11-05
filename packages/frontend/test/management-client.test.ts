import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MeResponse } from '@open-estate/shared';
import {
  createManagementClient,
  managementErrorMessage,
  MANAGEMENT_TIMEOUT_MS,
  MESSAGE_CODES,
  MESSAGE_STATUSES,
  type ManagementError,
  type Transport,
  type TransportRequest,
  type TransportResponse,
} from '../src/app/management/management-client';

const BASE = 'https://manage.example.org/v1/';

function response(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): TransportResponse {
  return {
    status,
    headers: { get: (name) => headers[name] ?? null },
    text: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

function recording(answer: (request: TransportRequest) => Promise<TransportResponse>) {
  const requests: TransportRequest[] = [];
  const transport: Transport = (request) => {
    requests.push(request);
    return answer(request);
  };
  return { requests, client: createManagementClient({ baseUrl: BASE, transport }) };
}

describe('createManagementClient', () => {
  it('builds URL, query, headers and JSON body', async () => {
    const { client, requests } = recording(() => Promise.resolve(response(201, { id: 'l-1' })));
    const result = await client.request('POST', '/listings', {
      query: {
        status: 'ACTIVE',
        types: ['villa', 'loft'],
        q: 'sea view',
        empty: '',
        none: undefined,
      },
      body: { title: 'x' },
      headers: { 'If-Match': '3' },
    });
    expect(result).toEqual({ ok: true, value: { id: 'l-1' } });
    expect(requests[0]).toMatchObject({
      method: 'POST',
      url: 'https://manage.example.org/v1/listings?status=ACTIVE&types=villa&types=loft&q=sea%20view',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'If-Match': '3' },
      body: '{"title":"x"}',
    });
  });

  it('returns undefined for an empty 2xx body and validates with parse', async () => {
    const empty = recording(() => Promise.resolve(response(204, '')));
    expect(await empty.client.request('DELETE', '/x')).toEqual({ ok: true, value: undefined });

    const me = {
      kind: 'user',
      id: 'u-1',
      displayName: 'U',
      role: 'AGENCY_MEMBER',
      agencyId: 'a-1',
      permissions: ['listing:read'],
    };
    const ok = recording(() => Promise.resolve(response(200, me)));
    expect(await ok.client.request('GET', '/me', { parse: (v) => MeResponse.parse(v) })).toEqual({
      ok: true,
      value: me,
    });

    const bad = recording(() => Promise.resolve(response(200, { kind: 'robot' })));
    const result = await bad.client.request('GET', '/me', { parse: (v) => MeResponse.parse(v) });
    expect(!result.ok && result.error.kind).toBe('invalid-response');
  });

  it('reports invalid JSON in a 2xx body', async () => {
    const { client } = recording(() => Promise.resolve(response(200, '{oops')));
    const result = await client.request('GET', '/me');
    expect(!result.ok && result.error).toMatchObject({ kind: 'invalid-response', status: 200 });
  });

  it('maps error responses to catalog errors, keeping field details', async () => {
    const body = {
      errors: [
        { code: 'INVALID_PARAMETER', message: 'too long', field: 'content.title' },
        { code: 'NOT_A_CODE', message: 'dropped' },
        'garbage',
      ],
    };
    const { client } = recording(() => Promise.resolve(response(400, body)));
    expect(await client.request('PUT', '/listings/l-1', { body: {} })).toEqual({
      ok: false,
      error: {
        kind: 'api',
        status: 400,
        errors: [{ code: 'INVALID_PARAMETER', message: 'too long', field: 'content.title' }],
      },
    });
  });

  it('reads the wait time of a 429 from body or Retry-After header', async () => {
    const fromBody = recording(() =>
      Promise.resolve(
        response(429, {
          errors: [{ code: 'RATE_LIMITED', message: 'slow' }],
          retryAfterSeconds: 7,
        }),
      ),
    );
    const a = await fromBody.client.request('GET', '/listings');
    expect(!a.ok && a.error).toMatchObject({ kind: 'api', status: 429, retryAfterSeconds: 7 });

    const fromHeader = recording(() => Promise.resolve(response(429, '', { 'Retry-After': '12' })));
    const b = await fromHeader.client.request('GET', '/listings');
    expect(!b.ok && b.error).toMatchObject({
      kind: 'api',
      status: 429,
      errors: [],
      retryAfterSeconds: 12,
    });
  });

  it('reports a network failure', async () => {
    const { client } = recording(() => Promise.reject(new Error('offline')));
    expect(await client.request('GET', '/me')).toEqual({
      ok: false,
      error: { kind: 'network', message: 'offline' },
    });
  });

  describe('timeout (Req 5.9)', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('gives up after 10 s and aborts the transport', async () => {
      // A transport that never answers and ignores the abort signal.
      const { client, requests } = recording(() => new Promise<TransportResponse>(() => undefined));
      const pending = client.request('GET', '/me');
      await jest.advanceTimersByTimeAsync(MANAGEMENT_TIMEOUT_MS - 1);
      expect(requests[0]?.signal.aborted).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      expect(await pending).toEqual({ ok: false, error: { kind: 'timeout', timeoutMs: 10_000 } });
      expect(requests[0]?.signal.aborted).toBe(true);
    });
  });

  it('reports a cancellation by the caller as aborted', async () => {
    const { client } = recording(
      (request) =>
        new Promise<TransportResponse>((_, reject) =>
          request.signal.addEventListener('abort', () => reject(new Error('aborted'))),
        ),
    );
    const controller = new AbortController();
    const pending = client.request('GET', '/me', { signal: controller.signal });
    controller.abort();
    expect(await pending).toEqual({ ok: false, error: { kind: 'aborted' } });

    const before = new AbortController();
    before.abort();
    expect(await client.request('GET', '/me', { signal: before.signal })).toEqual({
      ok: false,
      error: { kind: 'aborted' },
    });
  });
});

describe('managementErrorMessage (Req 5.7, 5.9)', () => {
  const api = (status: number, code?: string, retryAfterSeconds?: number): ManagementError => ({
    kind: 'api',
    status,
    errors: code ? [{ code: code as never, message: 'm' }] : [],
    ...(retryAfterSeconds !== undefined && { retryAfterSeconds }),
  });

  it.each<[ManagementError, unknown]>([
    [
      { kind: 'timeout', timeoutMs: 10_000 },
      { key: 'portal.error.timeout', params: { seconds: 10 } },
    ],
    [{ kind: 'network', message: 'x' }, { key: 'portal.error.network' }],
    [
      { kind: 'invalid-response', status: 200, message: 'x' },
      { key: 'portal.error.invalidResponse' },
    ],
    [{ kind: 'not-configured' }, { key: 'portal.error.notConfigured' }],
    [{ kind: 'aborted' }, undefined],
    [api(409, 'VERSION_CONFLICT'), { key: 'portal.error.code.VERSION_CONFLICT' }],
    [api(400, 'INVALID_PARAMETER'), { key: 'portal.error.status.400' }],
    [api(404), { key: 'portal.error.status.404' }],
    [api(429, 'RATE_LIMITED', 5), { key: 'portal.error.rateLimitedWait', params: { seconds: 5 } }],
    [api(429), { key: 'portal.error.status.429' }],
    [api(502), { key: 'portal.error.server' }],
    [api(418), { key: 'portal.error.client' }],
  ])('%j → %j', (error, expected) => {
    expect(managementErrorMessage(error)).toEqual(expected);
  });

  const translations = (locale: string): Record<string, string> =>
    JSON.parse(
      readFileSync(join(__dirname, '..', 'public', 'i18n', `${locale}.json`), 'utf8'),
    ) as Record<string, string>;

  it.each(['en', 'de'])('every message key exists in %s.json', (locale) => {
    const file = translations(locale);
    const errors: ManagementError[] = [
      { kind: 'timeout', timeoutMs: 1 },
      { kind: 'network', message: '' },
      { kind: 'invalid-response', status: 200, message: '' },
      { kind: 'not-configured' },
      api(500),
      api(418),
      api(429, undefined, 3),
      ...MESSAGE_STATUSES.map((status) => api(status)),
      ...MESSAGE_CODES.map((code) => api(400, code)),
    ];
    for (const error of errors) {
      const key = managementErrorMessage(error)?.key;
      expect(key !== undefined && file[key]).toBeTruthy();
    }
  });

  it('en.json and de.json have the same portal keys', () => {
    const portalKeys = (locale: string) =>
      Object.keys(translations(locale))
        .filter((key) => key.startsWith('portal.'))
        .sort();
    expect(portalKeys('de')).toEqual(portalKeys('en'));
  });
});
