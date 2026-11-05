import fc from 'fast-check';
import { z } from 'zod';
import {
  AgencyView,
  CustomId,
  formatDecimal,
  IsoDateTime,
  LISTING_BOUNDS,
  ListingBase,
  ListingContent,
  ListingStatusSchema,
  ListingView,
  MeResponse,
  VersionNumber,
  type ImportRecord,
  type ListingContentInput,
  type Principal,
} from '../src';
import {
  arbAgencies,
  arbAgencyInventory,
  arbImportRecord,
  arbListingInventory,
  arbOperations,
  arbPrincipal,
  arbSimulatedClock,
  referenceContentPaths,
  type ManagedListing,
} from './arbitraries';

// Sanity checks of the management generators: every generated value satisfies the shared schemas.

/** Internal Listing_Inhalt → API representation (amounts and area as decimal strings). */
function toInput(content: Record<string, unknown>): Record<string, unknown> {
  const input = { ...content };
  if (typeof input['area'] === 'number') input['area'] = formatDecimal(input['area']);
  if (Array.isArray(input['offers'])) {
    input['offers'] = (input['offers'] as Record<string, unknown>[]).map((offer) =>
      Object.fromEntries(
        Object.entries(offer).map(([key, value]) => [
          key,
          typeof value === 'number' ? formatDecimal(value) : value,
        ]),
      ),
    );
  }
  return input;
}

function expectValidPrincipal(principal: Principal): void {
  const me =
    principal.kind === 'machine'
      ? {
          kind: 'machine',
          id: principal.keyId,
          displayName: principal.label,
          agencyId: principal.agencyId,
          permissions: principal.permissions,
        }
      : {
          kind: 'user',
          id: principal.userId,
          displayName: principal.displayName,
          role: principal.role,
          ...('agencyId' in principal && { agencyId: principal.agencyId }),
          permissions: [],
        };
  expect(MeResponse.safeParse(me).error).toBeUndefined();
}

function expectValidListing(listing: ManagedListing): void {
  const view = {
    id: listing.id,
    content: toInput(listing.state.content),
    status: listing.state.status,
    origin: listing.origin,
    ...(listing.state.customId !== undefined && { customId: listing.state.customId }),
    ...(listing.state.agencyId !== undefined && { agencyId: listing.state.agencyId }),
    version: listing.version,
    updatedAt: listing.updatedAt,
    fieldSources: listing.fieldSources,
    sourceUrlDerived: false,
    source: 'sanity',
    lastImportedAt: listing.updatedAt,
    lastRunId: 'run-1',
  };
  const parsed = ListingView.safeParse(view);
  expect(parsed.error).toBeUndefined();
  // Fixed point: the internal content is exactly what the schema outputs.
  expect(parsed.data?.content).toEqual(listing.state.content);
  expect(Object.keys(listing.fieldSources).sort()).toEqual(
    referenceContentPaths(listing.state.content),
  );
  for (const source of Object.values(listing.fieldSources)) {
    expect(source.version).toBeLessThanOrEqual(listing.version);
  }
}

const nestedShape = (field: string): z.ZodObject | undefined => {
  const schema = ListingBase.shape[field as keyof typeof ListingBase.shape] as z.ZodType;
  const inner = schema instanceof z.ZodOptional ? schema.unwrap() : schema;
  return inner instanceof z.ZodObject ? inner : undefined;
};

/** Every delivered (non-null) value of an Import_Datensatz is a valid value of its field. */
function expectValidImportRecord(record: ImportRecord): void {
  const { id, customId, status, ...content } = record;
  if (id !== undefined) expect(z.string().max(LISTING_BOUNDS.id.max).min(1).parse(id)).toBe(id);
  if (customId !== undefined) expect(CustomId.safeParse(customId).success).toBe(true);
  if (status !== undefined) expect(ListingStatusSchema.safeParse(status).success).toBe(true);
  for (const [field, value] of Object.entries(toInput(content))) {
    if (value === null) continue;
    const nested = nestedShape(field);
    if (nested !== undefined) {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (child === null) continue;
        expect(nested.shape[key]?.safeParse(child).error).toBeUndefined();
      }
    } else {
      const schema = ListingBase.shape[field as keyof typeof ListingBase.shape] as z.ZodType;
      expect(schema.safeParse(value).error).toBeUndefined();
    }
  }
}

describe('management arbitraries', () => {
  it('principals of all roles and machine accesses are valid', () => {
    fc.assert(fc.property(arbPrincipal(), expectValidPrincipal));
  });

  it('agency inventories hold valid agencies and listings with unique keys', () => {
    fc.assert(
      fc.property(arbAgencyInventory(), ({ agencies, listings }) => {
        const agencyIds = new Set(agencies.map((a) => a.agencyId));
        for (const agency of agencies) expect(AgencyView.safeParse(agency).success).toBe(true);
        expect(new Set(listings.map((l) => l.id)).size).toBe(listings.length);
        const keys = listings.flatMap((l) =>
          l.state.customId === undefined ? [] : [`${l.state.agencyId ?? ''}#${l.state.customId}`],
        );
        expect(new Set(keys).size).toBe(keys.length);
        for (const listing of listings) {
          if (listing.state.agencyId !== undefined) {
            expect(agencyIds.has(listing.state.agencyId)).toBe(true);
          }
          expectValidListing(listing);
        }
      }),
    );
  });

  it('import records are deep subsets with valid values and the requested identity', () => {
    const arb = fc
      .tuple(arbAgencies({ maxLength: 2 }), fc.boolean())
      .chain(([agencies, agencyless]) => {
        const agencyIds = agencies.map((a) => a.agencyId);
        return arbListingInventory({ agencyIds, minLength: 2, maxLength: 6 }).chain((listings) => {
          const agencyId = agencyless ? undefined : agencyIds[0];
          return fc.tuple(
            fc.constant(listings),
            fc.constant(agencyId),
            arbImportRecord({ listings, ...(agencyId !== undefined && { agencyId }) }),
          );
        });
      });
    fc.assert(
      fc.property(arb, ([listings, agencyId, { identity, record }]) => {
        expectValidImportRecord(record);
        expect(record.id).toBe(identity.id);
        expect(record.customId).toBe(identity.customId);
        if (identity.kind === 'conflicting') {
          const byId = listings.find((l) => l.id === identity.id);
          const byCustomId = listings.find(
            (l) => l.state.agencyId === agencyId && l.state.customId === identity.customId,
          );
          expect(byId).toBeDefined();
          expect(byCustomId).toBeDefined();
          expect(byId).not.toBe(byCustomId);
        }
      }),
    );
  });

  it('operation sequences carry valid principals, contents and import records', () => {
    fc.assert(
      fc.property(arbOperations(), (operations) => {
        for (const op of operations) {
          expect(op.advanceMs).toBeGreaterThanOrEqual(0);
          if (op.kind === 'import') {
            expectValidImportRecord(op.record);
            continue;
          }
          if (op.kind !== 'delete') expectValidPrincipal(op.principal);
          if (op.kind === 'create' || op.kind === 'update') {
            const parsed = ListingContent.safeParse(toInput(op.content) as ListingContentInput);
            expect(parsed.data).toEqual(op.content);
          }
          if (op.kind === 'restore') expect(VersionNumber.safeParse(op.version).success).toBe(true);
        }
      }),
    );
  });

  it('the simulated clock only moves forward and yields ISO timestamps', () => {
    fc.assert(
      fc.property(arbSimulatedClock, fc.array(fc.nat(1_000_000)), (clock, steps) => {
        for (const step of steps) {
          const before = clock.now();
          expect(clock.advance(step)).toBe(before + step);
          expect(IsoDateTime.safeParse(clock.nowIso()).success).toBe(true);
        }
        expect(() => clock.advance(-1)).toThrow(RangeError);
      }),
    );
  });
});
