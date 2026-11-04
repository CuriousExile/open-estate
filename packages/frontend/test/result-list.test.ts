import type { LocalizedListing } from '@open-estate/shared';
import type { ApiResult, ClientError, SearchPage, SearchParams } from '../src/app/api/api-client';
import {
  createResultLoader,
  currentPage,
  formatMoney,
  hasNextPage,
  isEmptyResult,
  RESULT_PAGE_SIZE,
  resultErrorMessage,
  selectOffer,
  toResultRow,
  type ResultListState,
} from '../src/app/results/result-list-model';

/** Intl uses (narrow) no-break spaces in some locales; compare with plain spaces. */
const plain = (text: string | undefined) => text?.replace(/\s/g, ' ');

function listing(id: string, overrides: Partial<LocalizedListing> = {}): LocalizedListing {
  return {
    id,
    originalLocale: 'de',
    deliveredLocale: 'en',
    title: `Listing ${id}`,
    description: '',
    offers: [{ offerType: 'SALE', price: '450000.00', currency: 'EUR' }],
    listingType: 'loft',
    rooms: 3.5,
    area: '98.50',
    address: { city: 'Berlin', postalCode: '10115', country: 'DE' },
    sourceUrl: 'https://example.com/listing',
    media: [],
    tours: [],
    source: 'seed',
    lastImportedAt: '2026-01-01T00:00:00.000Z',
    lastRunId: 'run-1',
    ...overrides,
  };
}

const BOTH = listing('both', {
  offers: [
    { offerType: 'SALE', price: '450000.00', currency: 'EUR' },
    { offerType: 'RENT', coldRent: '1250.50', currency: 'CHF', warmRent: '1500.00' },
  ],
});

describe('selectOffer', () => {
  it('picks the offer of the filtered offer type for listings with SALE + RENT', () => {
    expect(selectOffer(BOTH, 'SALE')).toMatchObject({ offerType: 'SALE', price: '450000.00' });
    expect(selectOffer(BOTH, 'RENT')).toMatchObject({ offerType: 'RENT', coldRent: '1250.50' });
  });

  it('falls back to the first offer without a filter', () => {
    expect(selectOffer(BOTH, undefined)?.offerType).toBe('SALE');
  });
});

describe('formatMoney', () => {
  it('formats decimal strings per locale and currency, cents only when non-zero', () => {
    expect(plain(formatMoney('450000.00', 'EUR', 'de'))).toBe('450.000 €');
    expect(plain(formatMoney('450000', 'EUR', 'en'))).toBe('€450,000');
    expect(plain(formatMoney('1250.5', 'EUR', 'de'))).toBe('1.250,50 €');
    expect(plain(formatMoney('999999999.99', 'USD', 'en'))).toBe('$999,999,999.99');
  });

  it('shows values Intl cannot format as delivered', () => {
    expect(formatMoney('12.5', 'invalid', 'en')).toBe('12.5 invalid');
    expect(formatMoney('abc', 'EUR', 'en')).toBe('abc EUR');
  });
});

describe('toResultRow', () => {
  it('contains title, filtered offer type, city, price + currency, rooms, area and type (Req 7.4)', () => {
    const row = toResultRow(BOTH, 'RENT', 'de');
    expect({ ...row, price: plain(row.price) }).toEqual({
      listing: BOTH,
      id: 'both',
      title: 'Listing both',
      titleLocale: 'en',
      offerType: 'RENT',
      city: 'Berlin',
      price: '1.250,50 CHF',
      rooms: '3,5',
      area: '98,5',
      listingType: 'loft',
    });
    expect(plain(toResultRow(BOTH, 'SALE', 'en').price)).toBe('€450,000');
  });
});

describe('resultErrorMessage', () => {
  it.each<[ClientError, ReturnType<typeof resultErrorMessage>]>([
    [
      { kind: 'timeout', timeoutMs: 10_000 },
      { key: 'results.error.timeout', params: { seconds: 10 } },
    ],
    [{ kind: 'network', message: 'offline' }, { key: 'results.error.network' }],
    [{ kind: 'invalid-response', status: 200, message: 'x' }, { key: 'results.error.server' }],
    [{ kind: 'api', status: 400, errors: [] }, { key: 'results.error.request' }],
    [{ kind: 'api', status: 503, errors: [] }, { key: 'results.error.server' }],
    [{ kind: 'api', status: 429, errors: [] }, { key: 'results.error.rateLimited' }],
    [
      { kind: 'api', status: 429, errors: [], retryAfterSeconds: 30 },
      { key: 'results.error.rateLimitedRetry', params: { seconds: 30 } },
    ],
    [{ kind: 'aborted' }, undefined],
  ])('maps %j', (error, expected) => {
    expect(resultErrorMessage(error)).toEqual(expected);
  });
});

describe('createResultLoader', () => {
  interface Call {
    params: SearchParams;
    signal: AbortSignal | undefined;
    resolve: (result: ApiResult<SearchPage>) => void;
  }

  function setup() {
    const calls: Call[] = [];
    let state: ResultListState | undefined;
    const loader = createResultLoader(
      (params, { signal }) =>
        new Promise((resolve) => {
          calls.push({ params, signal, resolve });
        }),
      (next) => {
        state = next;
      },
    );
    const current = (): ResultListState => {
      if (state === undefined) throw new Error('no state reported');
      return state;
    };
    return { loader, calls, state: current };
  }

  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const page = (ids: string[], nextPageToken?: string): ApiResult<SearchPage> => ({
    ok: true,
    value: { items: ids.map((id) => listing(id)), ...(nextPageToken && { nextPageToken }) },
  });
  const ids = (state: ResultListState) => currentPage(state)?.items.map((item) => item.id);

  it('requests pages of 20 and follows nextPageToken; going back needs no request (Req 7.3)', async () => {
    const { loader, calls, state } = setup();
    loader.search({ offerType: 'RENT', city: 'Berlin' });
    expect(state()).toMatchObject({ searched: true, loading: true, offerType: 'RENT' });
    expect(calls[0]?.params).toEqual({ offerType: 'RENT', city: 'Berlin', pageSize: 20 });
    expect(RESULT_PAGE_SIZE).toBe(20);

    calls[0]?.resolve(page(['a'], 'token-2'));
    await flush();
    expect(ids(state())).toEqual(['a']);
    expect(hasNextPage(state())).toBe(true);

    loader.next();
    expect(calls[1]?.params).toEqual({
      offerType: 'RENT',
      city: 'Berlin',
      pageSize: 20,
      pageToken: 'token-2',
    });
    calls[1]?.resolve(page(['b']));
    await flush();
    expect(state()).toMatchObject({ pageIndex: 1, loading: false });
    expect(ids(state())).toEqual(['b']);
    expect(hasNextPage(state())).toBe(false);

    loader.previous();
    expect(ids(state())).toEqual(['a']);
    loader.next();
    expect(ids(state())).toEqual(['b']);
    expect(calls).toHaveLength(2);
  });

  it('reports an empty first page as "no results" (Req 7.6)', async () => {
    const { loader, calls, state } = setup();
    loader.search({ offerType: 'SALE' });
    expect(isEmptyResult(state())).toBe(false);
    calls[0]?.resolve(page([]));
    await flush();
    expect(isEmptyResult(state())).toBe(true);
  });

  it('keeps the shown page on an error and retries the failed request (Req 7.7)', async () => {
    const { loader, calls, state } = setup();
    loader.search({ offerType: 'SALE' });
    calls[0]?.resolve(page(['a'], 'token-2'));
    await flush();

    loader.next();
    calls[1]?.resolve({ ok: false, error: { kind: 'timeout', timeoutMs: 10_000 } });
    await flush();
    expect(state()).toMatchObject({ pageIndex: 0, loading: false, error: { kind: 'timeout' } });
    expect(ids(state())).toEqual(['a']);

    loader.retry();
    expect(calls[2]?.params.pageToken).toBe('token-2');
    expect(state().error).toBeUndefined();
    calls[2]?.resolve(page(['b']));
    await flush();
    expect(state()).toMatchObject({ pageIndex: 1, error: undefined });
  });

  it('discards old pages on a new search and ignores answers of superseded searches', async () => {
    const { loader, calls, state } = setup();
    loader.search({ offerType: 'SALE' });
    calls[0]?.resolve(page(['a']));
    await flush();

    loader.search({ offerType: 'RENT' });
    expect(calls[0]?.signal?.aborted).toBe(false); // already answered
    expect(state()).toMatchObject({ pages: [], loading: true, offerType: 'RENT' });
    loader.search({ offerType: 'SALE', city: 'Hamburg' });
    expect(calls[1]?.signal?.aborted).toBe(true);

    calls[2]?.resolve(page(['c']));
    calls[1]?.resolve(page(['stale']));
    await flush();
    expect(ids(state())).toEqual(['c']);
    expect(state().offerType).toBe('SALE');
  });
});
