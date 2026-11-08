import fc from 'fast-check';
import type { z } from 'zod';
import {
  AuditLogQuery,
  canonicalJson,
  CONTENT_FIELDS,
  CreateListingRequest,
  CreateMachineAccessRequest,
  CustomId,
  DiffQuery,
  ERROR_HTTP_STATUS,
  ListListingsQuery,
  ListingBase,
  ListingContent,
  MANAGEMENT_BOUNDS,
  ManualContentInput,
  ReplaceContentRequest,
  toApiErrors,
  UpdateAgencyRequest,
} from '../../src';

/** Valid Listing_Inhalt in API representation; `overrides` replace top-level fields. */
function content(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    originalLocale: 'de',
    title: 'Helle Altbauwohnung',
    description: 'Drei Zimmer mit Balkon.',
    translations: [{ locale: 'en', title: 'Bright period flat', description: 'Three rooms.' }],
    offers: [{ offerType: 'SALE', price: '350000.50', currency: 'EUR' }],
    listingType: 'apartment_unit',
    rooms: 3.5,
    area: '85.5',
    address: { city: 'Berlin', postalCode: '10115', country: 'DE' },
    sourceUrl: 'https://agency.example/listings/1',
    media: [],
    tours: [],
    ...overrides,
  };
}

const errorsOf = (schema: z.ZodType, value: unknown) =>
  toApiErrors(schema.safeParse(value).error?.issues ?? []);

describe('Listing_Inhalt', () => {
  it('consists of all listing fields except id and provenance fields', () => {
    const excluded = ['id', 'source', 'lastImportedAt', 'lastRunId'];
    const expected = Object.keys(ListingBase.shape).filter((k) => !excluded.includes(k));
    expect([...CONTENT_FIELDS].sort()).toEqual(expected.sort());
    expect(Object.keys(ListingContent.shape).sort()).toEqual(expected.sort());
  });
});

describe('ManualContentInput', () => {
  it('accepts content without sourceUrl (Req 4.5) and outputs minor units', () => {
    const result = ManualContentInput.safeParse(content({ sourceUrl: undefined }));
    expect(result.success).toBe(true);
    expect(result.data?.sourceUrl).toBeUndefined();
    expect(result.data?.area).toBe(8550);
  });

  it('validates with the listing rules (Req 4.3, 4.4)', () => {
    const errors = errorsOf(
      ManualContentInput,
      content({ title: '', translations: [{ locale: 'de', title: 'x', description: '' }] }),
    );
    expect(errors.map((e) => e.field)).toEqual(['title', 'translations.0.locale']);
  });

  it('strips id and provenance fields', () => {
    const parsed = ManualContentInput.parse(content({ id: 'x', source: 'y' }));
    expect(parsed).not.toHaveProperty('id');
    expect(parsed).not.toHaveProperty('source');
  });
});

describe('Custom_Id', () => {
  it('accepts exactly 1–128 characters (Req 4.11)', () => {
    const { min, max } = MANAGEMENT_BOUNDS.customId;
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: max + 10 }), (id) => {
        expect(CustomId.safeParse(id).success).toBe(id.length >= min && id.length <= max);
      }),
      { numRuns: 100 },
    );
  });
});

describe('listing requests', () => {
  it('creates listings as INACTIVE by default (Req 4.2)', () => {
    expect(CreateListingRequest.parse({ content: content() }).status).toBe('INACTIVE');
    expect(CreateListingRequest.parse({ content: content(), status: 'ACTIVE' }).status).toBe(
      'ACTIVE',
    );
  });

  it('requires baseVersion ≥ 1 and rejects unknown keys', () => {
    expect(errorsOf(ReplaceContentRequest, { content: content(), baseVersion: 0 })).toEqual([
      expect.objectContaining({ code: 'INVALID_PARAMETER', field: 'baseVersion' }),
    ]);
    expect(
      ReplaceContentRequest.safeParse({ content: content(), baseVersion: 1, status: 'ACTIVE' })
        .success,
    ).toBe(false);
  });

  it('accepts customId null (remove) and absent (keep)', () => {
    const base = { content: content(), baseVersion: 1 };
    expect(ReplaceContentRequest.parse({ ...base, customId: null }).customId).toBeNull();
    expect('customId' in ReplaceContentRequest.parse(base)).toBe(false);
  });

  it('coerces query strings and defaults pageSize', () => {
    expect(ListListingsQuery.parse({ status: 'ACTIVE', pageSize: '5' })).toMatchObject({
      status: 'ACTIVE',
      pageSize: 5,
    });
    expect(ListListingsQuery.parse({}).pageSize).toBe(MANAGEMENT_BOUNDS.pageSize.default);
    expect(DiffQuery.parse({ from: '1', to: '3' })).toEqual({ from: 1, to: 3 });
  });

  it('parses a lookup by ids: 1 to 50 comma-separated ids, without other filters or paging', () => {
    expect(ListListingsQuery.parse({ ids: 'a,b,c' }).ids).toEqual(['a', 'b', 'c']);
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `id-${i}`).join(',');
    expect(ListListingsQuery.safeParse({ ids: ids(50) }).success).toBe(true);
    expect(ListListingsQuery.safeParse({ ids: ids(51) }).success).toBe(false);
    expect(ListListingsQuery.safeParse({ ids: '' }).success).toBe(false);
    expect(ListListingsQuery.safeParse({ ids: 'a,,b' }).success).toBe(false);
    for (const other of [
      { status: 'ACTIVE' },
      { q: 'Loft' },
      { agencyId: 'a1' },
      { pageToken: 't' },
    ]) {
      const result = ListListingsQuery.safeParse({ ids: 'a', ...other });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual(['ids']);
    }
    // pageSize has a default and is ignored by the lookup.
    expect(ListListingsQuery.safeParse({ ids: 'a', pageSize: '5' }).success).toBe(true);
  });

  it('rejects an empty agency update', () => {
    expect(UpdateAgencyRequest.safeParse({}).success).toBe(false);
    expect(UpdateAgencyRequest.safeParse({ state: 'SUSPENDED' }).success).toBe(true);
  });
});

describe('machine access permissions', () => {
  it('reports each unknown permission as INVALID_PERMISSION (Req 3.3)', () => {
    const errors = errorsOf(CreateMachineAccessRequest, {
      label: 'CRM',
      permissions: ['listing:read', 'listing:delete', 'root'],
    });
    expect(errors).toEqual([
      expect.objectContaining({
        code: 'INVALID_PERMISSION',
        field: 'permissions.1',
        details: { permission: 'listing:delete' },
      }),
      expect.objectContaining({
        code: 'INVALID_PERMISSION',
        field: 'permissions.2',
        details: { permission: 'root' },
      }),
    ]);
    expect(ERROR_HTTP_STATUS.INVALID_PERMISSION).toBe(400);
  });

  it('collapses duplicate permissions', () => {
    const parsed = CreateMachineAccessRequest.parse({
      label: 'CRM',
      permissions: ['listing:read', 'listing:read'],
    });
    expect(parsed.permissions).toEqual(['listing:read']);
  });
});

describe('periods', () => {
  it('rejects from > to with INVALID_RANGE', () => {
    expect(
      errorsOf(AuditLogQuery, { from: '2025-02-01T00:00:00Z', to: '2025-01-01T00:00:00Z' }),
    ).toEqual([expect.objectContaining({ code: 'INVALID_RANGE', field: 'from' })]);
  });
});

describe('management error codes', () => {
  it.each([
    ['AUTH_MISSING', 401],
    ['AUTH_INVALID', 401],
    ['MACHINE_ACCESS_EXPIRED', 401],
    ['AGENCY_SUSPENDED', 403],
    ['METRIC_NOT_ALLOWED', 403],
    ['VERSION_CONFLICT', 409],
    ['CUSTOM_ID_TAKEN', 409],
    ['DELETION_BLOCKED', 409],
    ['LAST_AGENCY_ADMIN', 409],
    ['LAST_PLATFORM_ADMIN', 409],
    ['USER_ALREADY_ASSIGNED', 409],
    ['INVALID_PERMISSION', 400],
    ['UNKNOWN_METRIC', 400],
  ] as const)('%s → %i', (code, status) => {
    expect(ERROR_HTTP_STATUS[code]).toBe(status);
  });
});

describe('canonicalJson', () => {
  it('is exported and independent of key order', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
      canonicalJson({ a: { c: 3, d: 2 }, b: 1 }),
    );
  });
});
