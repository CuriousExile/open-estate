import {
  agencyScope,
  DuplicateDetector,
  DuplicateIndexUnavailable,
  InMemoryDuplicateIndexStore,
  InMemoryTransactor,
  type StoredProfile,
} from '@open-estate/core';
import {
  assertValidTaxonomy,
  blockKeys,
  buildProfile,
  DEFAULT_DUPLICATE_CONFIG,
  DEFAULT_TAXONOMY_CONFIG,
  ListingContent,
  publicDetailUrl,
} from '@open-estate/shared';

// DuplicateDetector (duplicate-detection design: "DuplicateDetector", Req 4, 5.8, 8.3).

const taxonomy = assertValidTaxonomy(DEFAULT_TAXONOMY_CONFIG);
const config = DEFAULT_DUPLICATE_CONFIG;
const scope = agencyScope('agy-1');

const content = (overrides: Record<string, unknown> = {}) =>
  ListingContent.parse({
    originalLocale: 'de',
    title: 'Helle Altbauwohnung mit Balkon',
    description: 'Drei Zimmer, Blick in den Hof.',
    translations: [],
    offers: [{ offerType: 'SALE', price: '350000.00', currency: 'EUR' }],
    listingType: 'apartment_unit',
    rooms: 3,
    area: '85.50',
    address: { city: 'Berlin', postalCode: '10115', country: 'DE', street: 'Hauptstraße 12' },
    sourceUrl: 'https://makler.example/w/1',
    media: [],
    tours: [],
    ...overrides,
  });

async function setup(options: { lagging?: boolean } = {}) {
  const index = new InMemoryDuplicateIndexStore(options);
  const tx = new InMemoryTransactor();
  const detector = new DuplicateDetector({ index, taxonomy, config });
  const store = async (
    listingId: string,
    overrides: Partial<StoredProfile> = {},
    contentOverrides: Record<string, unknown> = {},
  ) => {
    const profile = buildProfile(content(contentOverrides), { taxonomy, config });
    const record: StoredProfile = {
      listingId,
      scope,
      createdAt: '2026-01-01T00:00:00.000Z',
      listingVersion: 1,
      profile,
      blockKeys: blockKeys(profile, config),
      dismissed: [],
      ...overrides,
    };
    // Like the writer: only the first listing with an exact key claims it.
    const owner = await index.exactOwner(record.scope, profile.exactKey);
    const result = await tx.transact([
      ...index.syncOps(null, record),
      ...(owner === null ? [index.claimExactOp(record.scope, profile.exactKey, listingId)] : []),
    ]);
    expect(result.ok).toBe(true);
    return record;
  };
  const assess = (overrides: Partial<Parameters<DuplicateDetector['assess']>[0]> = {}) =>
    detector.assess({
      listingId: 'new',
      scope,
      createdAt: '2026-03-01T00:00:00.000Z',
      content: content(),
      dismissed: [],
      ...overrides,
    });
  return { index, detector, store, assess };
}

describe('DuplicateDetector.assess', () => {
  it('names the oldest older Treffer as Original and sorts Treffer by score', async () => {
    const s = await setup();
    await s.store('old', { createdAt: '2026-01-01T00:00:00.000Z' });
    await s.store(
      'older-but-weaker',
      { createdAt: '2025-12-01T00:00:00.000Z' },
      { title: 'Wohnung mit Balkon', description: 'Hof.' },
    );
    await s.store('younger', { createdAt: '2026-04-01T00:00:00.000Z' });

    const result = await s.assess();

    // Descending score, ties by id; the weaker one has other text but still clamps to 1.
    const ranked = result.matches.map((m) => [m.listingId, m.score]);
    expect(ranked).toEqual([...ranked].sort((a, b) => Number(b[1]) - Number(a[1])));
    expect(result.matches.map((m) => m.listingId).sort()).toEqual([
      'old',
      'older-but-weaker',
      'younger',
    ]);
    const exact = result.matches.filter((m) => m.reasons.includes('EXACT')).map((m) => m.listingId);
    expect(exact.sort()).toEqual(['old', 'younger']);
    // The Original is the oldest older Treffer, regardless of its score.
    expect(result.original).toBe('older-but-weaker');
    expect(result.exactOwner).toBe('old');
    expect(result.truncated).toBe(false);
  });

  it('is no duplicate when every Treffer is younger', async () => {
    const s = await setup();
    await s.store('younger', { createdAt: '2026-04-01T00:00:00.000Z' });
    const result = await s.assess();
    expect(result.matches.map((m) => m.listingId)).toEqual(['younger']);
    expect(result.original).toBeNull();
  });

  it('never compares with itself or with another Prüfbereich', async () => {
    const s = await setup();
    await s.store('new');
    await s.store('foreign', { scope: agencyScope('agy-2') });
    const result = await s.assess();
    expect(result.matches).toEqual([]);
  });

  it('honours a Verwerfung in both directions (Req 8.3)', async () => {
    const s = await setup();
    await s.store('released', { dismissed: ['new'] });
    await s.store('dismissed-by-new');
    const result = await s.assess({ dismissed: ['dismissed-by-new'] });
    expect(result.matches).toEqual([]);
  });

  it('finds an Exakt_Duplikat the lagging GSI does not show yet', async () => {
    const s = await setup({ lagging: true });
    await s.store('just-created');
    const result = await s.assess();
    expect(result.matches.map((m) => m.listingId)).toEqual(['just-created']);
    expect(result.original).toBe('just-created');
  });

  it('ignores the derived public detail URL as source URL (Req 3.1)', async () => {
    const s = await setup();
    const derived = publicDetailUrl('https://portal.example', 'new');
    const result = await s.assess({
      content: content({ sourceUrl: derived }),
      derivedSourceUrl: derived,
    });
    expect(result.profile.sourceUrlHash).toBeUndefined();
  });

  it('reports an unreachable index or a passed deadline as unavailable (Req 5.8)', async () => {
    const s = await setup();
    jest.spyOn(s.index, 'candidates').mockRejectedValueOnce(new Error('throttled'));
    await expect(s.assess()).rejects.toBeInstanceOf(DuplicateIndexUnavailable);

    const aborted = new AbortController();
    aborted.abort(new Error('deadline'));
    await expect(
      s.detector.assess(
        {
          listingId: 'new',
          scope,
          createdAt: '2026-03-01T00:00:00.000Z',
          content: content(),
          dismissed: [],
        },
        aborted.signal,
      ),
    ).rejects.toBeInstanceOf(DuplicateIndexUnavailable);
  });
});

describe('assessAcross (Duplikat_Abgleich, Req 10.3, 11.1)', () => {
  it('adds duplicates of other Prüfbereiche and every listing with the same exact key', async () => {
    const { detector, store } = await setup();
    await store('own-old', { createdAt: '2026-01-01T00:00:00.000Z' });
    await store('own-dismissed', { createdAt: '2026-01-02T00:00:00.000Z', dismissed: ['new'] });
    await store('foreign', { scope: agencyScope('agy-2') });
    await store(
      'foreign-other',
      { scope: agencyScope('agy-2') },
      {
        title: 'Loft am Hafen',
        rooms: 1,
        address: { city: 'Berlin', postalCode: '10115', country: 'DE', street: 'Kaje 7' },
        sourceUrl: 'https://makler.example/w/2',
      },
    );
    const input = {
      listingId: 'new',
      scope,
      createdAt: '2026-03-01T00:00:00.000Z',
      content: content(),
      dismissed: [],
    };

    const across = await detector.assessAcross(input);
    const plain = await detector.assess(input);

    // Within the Prüfbereich exactly what the write path sees (Verwerfungen apply).
    expect(across.assessment).toEqual(plain);
    expect(plain.matches.map((m) => m.listingId)).toEqual(['own-old']);
    // Across Prüfbereiche without Verwerfungen; only duplicates.
    expect(across.crossMatches).toEqual([
      { listingId: 'foreign', scope: agencyScope('agy-2'), score: 1, reasons: ['EXACT'] },
    ]);
    expect(across.exactPeers.map((p) => p.listingId).sort()).toEqual(['own-dismissed', 'own-old']);
    expect(across.truncated).toBe(false);
  });
});
