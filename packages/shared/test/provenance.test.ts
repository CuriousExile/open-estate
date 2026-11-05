import { deriveProvenance, HttpUrl, Listing, LISTING_BOUNDS, publicDetailUrl } from '../src';

const ORIGIN = 'https://open-estate.example';
const AT = '2025-03-01T12:00:00.000Z';

/** Valid listing in API/raw representation with the given provenance fields. */
function listingWith(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'lst-1',
    originalLocale: 'de',
    title: 'Helle Altbauwohnung',
    description: 'Drei Zimmer.',
    translations: [],
    offers: [{ offerType: 'SALE', price: '350000', currency: 'EUR' }],
    listingType: 'apartment_unit',
    rooms: 3,
    area: '85.5',
    address: { city: 'Berlin', postalCode: '10115', country: 'DE' },
    sourceUrl: 'https://partner.example/listings/1',
    media: [],
    tours: [],
    source: 'partner-api',
    lastImportedAt: AT,
    lastRunId: 'run-1',
    ...fields,
  };
}

describe('publicDetailUrl', () => {
  it('builds <origin>/listings/{id}', () => {
    expect(publicDetailUrl(ORIGIN, 'lst-1')).toBe(`${ORIGIN}/listings/lst-1`);
  });

  it('percent-encodes the id', () => {
    expect(publicDetailUrl(ORIGIN, 'a/b ?#ä')).toBe(`${ORIGIN}/listings/a%2Fb%20%3F%23%C3%A4`);
  });

  it('yields a valid sourceUrl for a maximal id', () => {
    const url = publicDetailUrl(ORIGIN, '€'.repeat(LISTING_BOUNDS.id.max));
    expect(HttpUrl.safeParse(url).success).toBe(true);
    expect(Listing.safeParse(listingWith({ sourceUrl: url })).success).toBe(true);
  });

  it('rejects URLs longer than LISTING_BOUNDS.url.max', () => {
    expect(() => publicDetailUrl(`https://${'a'.repeat(LISTING_BOUNDS.url.max)}`, 'x')).toThrow(
      RangeError,
    );
  });
});

describe('deriveProvenance', () => {
  it('keeps the connector id and uses the runId for imports', () => {
    expect(
      deriveProvenance(
        { origin: 'IMPORT', source: 'partner-api', agencyId: 'ag-1' },
        { channel: 'IMPORT', version: 3, at: AT, runId: 'run-42' },
      ),
    ).toEqual({ source: 'partner-api', lastImportedAt: AT, lastRunId: 'run-42' });
  });

  it('uses {channel}#{version} for manual edits of imported listings', () => {
    expect(
      deriveProvenance(
        { origin: 'IMPORT', source: 'partner-api', agencyId: 'ag-1' },
        { channel: 'PORTAL', version: 7, at: AT },
      ),
    ).toEqual({ source: 'partner-api', lastImportedAt: AT, lastRunId: 'PORTAL#7' });
  });

  it.each(['PORTAL', 'API', 'ADMIN'] as const)(
    'derives agency:{agencyId} and %s#{version} for MANUAL listings',
    (channel) => {
      expect(
        deriveProvenance(
          { origin: 'MANUAL', source: 'agency:ag-old', agencyId: 'ag-new' },
          { channel, version: 2, at: AT },
        ),
      ).toEqual({ source: 'agency:ag-new', lastImportedAt: AT, lastRunId: `${channel}#2` });
    },
  );

  it('produces values accepted by the unchanged Listing schema', () => {
    const provenance = deriveProvenance(
      { origin: 'MANUAL', source: '', agencyId: '0f8fad5b-d9cb-469f-a165-70867728950e' },
      { channel: 'ADMIN', version: Number.MAX_SAFE_INTEGER, at: AT },
    );
    expect(Listing.safeParse(listingWith(provenance)).success).toBe(true);
  });

  it('rejects a MANUAL listing without agency', () => {
    expect(() =>
      deriveProvenance({ origin: 'MANUAL', source: '' }, { channel: 'API', version: 1, at: AT }),
    ).toThrow(RangeError);
  });

  it('rejects derived values outside LISTING_BOUNDS', () => {
    const agencyId = 'a'.repeat(LISTING_BOUNDS.source.max);
    expect(() =>
      deriveProvenance(
        { origin: 'MANUAL', source: '', agencyId },
        { channel: 'API', version: 1, at: AT },
      ),
    ).toThrow(RangeError);
    expect(() =>
      deriveProvenance(
        { origin: 'IMPORT', source: 'partner-api' },
        { channel: 'IMPORT', version: 1, at: AT, runId: 'r'.repeat(LISTING_BOUNDS.runId.max + 1) },
      ),
    ).toThrow(RangeError);
  });
});
