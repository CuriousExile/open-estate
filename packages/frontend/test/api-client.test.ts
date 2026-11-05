import {
  API_TIMEOUT_MS,
  buildQuery,
  createApiClient,
  type FetchFn,
  type FetchResponse,
} from '../src/app/api/api-client';

interface Call {
  url: string;
  signal: AbortSignal;
}

function response(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): FetchResponse {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    headers: { get: (name) => lower.get(name.toLowerCase()) ?? null },
    text: () => Promise.resolve(body),
  };
}

/** Fake fetch answering every call with `reply`; records URL and signal. */
function fakeFetch(reply: (call: Call) => Promise<FetchResponse>): {
  fetch: FetchFn;
  calls: Call[];
} {
  const calls: Call[] = [];
  return {
    calls,
    fetch: (url, init) => {
      const call = { url, signal: init.signal };
      calls.push(call);
      return reply(call);
    },
  };
}

/** Never resolves; rejects like the browser when the signal aborts. */
const hanging = ({ signal }: Call): Promise<FetchResponse> =>
  new Promise((_, reject) =>
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
  );

const ok = (body: unknown) => () => Promise.resolve(response(200, JSON.stringify(body)));

function client(fetch: FetchFn, locale = 'de-AT') {
  let current = locale;
  return {
    api: createApiClient({
      baseUrl: 'https://api.example.org/v1/',
      fetch,
      getLocale: () => current,
    }),
    setLocale: (l: string) => (current = l),
  };
}

describe('ApiClient requests', () => {
  it('sends a simple CORS request: GET with the safelisted Accept only, no preflight', async () => {
    const inits: Parameters<FetchFn>[1][] = [];
    const fetch: FetchFn = (_url, init) => {
      inits.push(init);
      return ok({ items: [] })();
    };
    const { api } = client(fetch);
    await api.searchListings({});
    await api.getListing('x-1');
    await api.getMeta();
    // `Authorization` or custom headers would trigger a preflight (API-key mode, see design).
    expect(inits.map(({ method, headers }) => ({ method, headers }))).toEqual(
      Array(3).fill({ method: 'GET', headers: { Accept: 'application/json' } }),
    );
  });

  it('sends the active locale as lang on every call (Req 13.10)', async () => {
    const { fetch, calls } = fakeFetch(ok({ items: [] }));
    const { api, setLocale } = client(fetch);
    await api.searchListings({});
    setLocale('en');
    await api.getMeta();
    expect(calls.map((c) => c.url)).toEqual([
      'https://api.example.org/v1/listings?lang=de-AT',
      'https://api.example.org/v1/meta?lang=en',
    ]);
  });

  it('builds the search query with repeated types, decimal strings and encoding', async () => {
    const { fetch, calls } = fakeFetch(ok({ items: [], nextPageToken: 'n' }));
    const result = await client(fetch).api.searchListings({
      offerType: 'RENT',
      priceMin: '500.50',
      priceMax: '1200',
      roomsMin: '2.5',
      areaMin: '',
      city: 'Bad Tölz & Umgebung',
      types: ['apartment_unit', 'loft'],
      hasTour: true,
      pageSize: 20,
      pageToken: 'a+b/c=',
    });
    expect(result).toEqual({ ok: true, value: { items: [], nextPageToken: 'n' } });
    expect(calls[0]?.url).toBe(
      'https://api.example.org/v1/listings?offerType=RENT&priceMin=500.50&priceMax=1200' +
        '&roomsMin=2.5&city=Bad%20T%C3%B6lz%20%26%20Umgebung&types=apartment_unit&types=loft' +
        '&hasTour=true&pageSize=20&pageToken=a%2Bb%2Fc%3D&lang=de-AT',
    );
  });

  it('sends the country filter after postalCode', async () => {
    const { fetch, calls } = fakeFetch(ok({ items: [] }));
    await client(fetch).api.searchListings({ city: 'Pattaya', postalCode: '20150', country: 'TH' });
    expect(calls[0]?.url).toBe(
      'https://api.example.org/v1/listings?city=Pattaya&postalCode=20150&country=TH&lang=de-AT',
    );
  });

  it('loads /locations and rejects a malformed document', async () => {
    const doc = {
      countries: [{ code: 'TH', count: 2 }],
      cities: [{ name: 'Pattaya', country: 'TH', count: 2 }],
    };
    const { fetch, calls } = fakeFetch(ok(doc));
    await expect(client(fetch).api.getLocations()).resolves.toEqual({ ok: true, value: doc });
    expect(calls[0]?.url).toBe('https://api.example.org/v1/locations?lang=de-AT');
    const bad = fakeFetch(ok({ countries: [{ code: 'th', count: 1 }], cities: [] }));
    await expect(client(bad.fetch).api.getLocations()).resolves.toMatchObject({
      ok: false,
      error: { kind: 'invalid-response' },
    });
  });

  it('URL-encodes the listing id', async () => {
    const { fetch, calls } = fakeFetch(ok({ id: 'a/b c' }));
    const result = await client(fetch).api.getListing('a/b c');
    expect(result).toEqual({ ok: true, value: { id: 'a/b c' } });
    expect(calls[0]?.url).toBe('https://api.example.org/v1/listings/a%2Fb%20c?lang=de-AT');
  });

  it('buildQuery omits undefined/empty values and empty arrays', () => {
    expect(
      buildQuery([
        ['a', undefined],
        ['b', ''],
        ['c', []],
        ['d', false],
      ]),
    ).toBe('?d=false');
    expect(buildQuery([])).toBe('');
  });
});

describe('ApiClient errors (Req 7.7)', () => {
  afterEach(() => jest.useRealTimers());

  it('times out after 10 s and aborts the request', async () => {
    jest.useFakeTimers();
    const { fetch, calls } = fakeFetch(hanging);
    const pending = client(fetch).api.searchListings({});
    await jest.advanceTimersByTimeAsync(API_TIMEOUT_MS - 1);
    expect(calls[0]?.signal.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({
      ok: false,
      error: { kind: 'timeout', timeoutMs: 10_000 },
    });
    expect(calls[0]?.signal.aborted).toBe(true);
  });

  it('reports ErrorResponse entries with status', async () => {
    const body = {
      errors: [
        { code: 'INVALID_RANGE', message: 'min > max', field: 'priceMin' },
        { code: 'NOT_A_CODE', message: 'dropped' },
      ],
    };
    const { fetch } = fakeFetch(() => Promise.resolve(response(400, JSON.stringify(body))));
    await expect(client(fetch).api.searchListings({})).resolves.toEqual({
      ok: false,
      error: {
        kind: 'api',
        status: 400,
        errors: [{ code: 'INVALID_RANGE', message: 'min > max', field: 'priceMin' }],
      },
    });
  });

  it.each([
    ['body field', { errors: [], retryAfterSeconds: 7 }, {}, 7],
    ['Retry-After header', { errors: [] }, { 'Retry-After': '12' }, 12],
  ])('reports retryAfterSeconds on 429 from %s', async (_, body, headers, expected) => {
    const { fetch } = fakeFetch(() =>
      Promise.resolve(response(429, JSON.stringify(body), headers)),
    );
    const result = await client(fetch).api.getListing('x');
    expect(result).toEqual({
      ok: false,
      error: { kind: 'api', status: 429, errors: [], retryAfterSeconds: expected },
    });
  });

  it('reports non-JSON error bodies as api error without entries', async () => {
    const { fetch } = fakeFetch(() => Promise.resolve(response(502, '<html>Bad Gateway</html>')));
    await expect(client(fetch).api.getMeta()).resolves.toEqual({
      ok: false,
      error: { kind: 'api', status: 502, errors: [] },
    });
  });

  it('reports network failures', async () => {
    const { fetch } = fakeFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    await expect(client(fetch).api.searchListings({})).resolves.toEqual({
      ok: false,
      error: { kind: 'network', message: 'Failed to fetch' },
    });
  });

  it.each([
    ['broken JSON', '{"items": ['],
    ['unexpected shape', '{"items": [{"title": "no id"}]}'],
  ])('reports %s on 2xx as invalid-response', async (_, body) => {
    const { fetch } = fakeFetch(() => Promise.resolve(response(200, body)));
    const result = await client(fetch).api.searchListings({});
    expect(result).toMatchObject({ ok: false, error: { kind: 'invalid-response', status: 200 } });
  });

  it('can be aborted by the caller so stale searches are discarded', async () => {
    const { fetch, calls } = fakeFetch(hanging);
    const controller = new AbortController();
    const pending = client(fetch).api.searchListings({}, { signal: controller.signal });
    controller.abort();
    await expect(pending).resolves.toEqual({ ok: false, error: { kind: 'aborted' } });
    expect(calls[0]?.signal.aborted).toBe(true);

    await expect(
      client(fetch).api.searchListings({}, { signal: controller.signal }),
    ).resolves.toEqual({ ok: false, error: { kind: 'aborted' } });
    expect(calls).toHaveLength(1);
  });
});
