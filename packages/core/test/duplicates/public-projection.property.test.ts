// Feature: duplicate-detection, Property 3: Öffentliche Projektion mit Objektmerkmalen
import { fromListingItem, toManagedListingItem, type ListingManagement } from '@open-estate/core';
import {
  assertValidTaxonomy,
  DEFAULT_TAXONOMY_CONFIG,
  LocalizedListing,
  serialize,
  type ListingFlag,
} from '@open-estate/shared';
import fc from 'fast-check';
import { arbListing } from '../../../shared/test/arbitraries';

/**
 * For any stored listing with any subset of Objektmerkmale and Markierungen, the public
 * projection (`fromListingItem` → `serialize`) contains exactly the stored merkmale — absent ones
 * stay absent, none is filled with a default — is accepted by `LocalizedListing`, and contains
 * neither Markierungen nor any other Verwaltungsdaten.
 *
 * **Validates: Requirements 1.5, 1.6, 7.4**
 */

const taxonomy = assertValidTaxonomy(DEFAULT_TAXONOMY_CONFIG);
const MERKMALE = [
  'floor',
  'totalFloors',
  'yearBuilt',
  'plotArea',
  'bedrooms',
  'bathrooms',
  'parcelId',
] as const;
const MANAGEMENT_KEYS = [
  'status',
  'origin',
  'version',
  'contentHash',
  'fieldSources',
  'flags',
  'flagCodes',
  'createdAt',
  'customId',
  'updatedAt',
  'gsiPk',
];

const flag: ListingFlag = {
  code: 'DUPLICATE',
  updatedAt: '2026-01-02T10:00:00.000Z',
  detectedBy: 'CREATE',
  originalId: 'lst-0',
  matches: [{ listingId: 'lst-0', score: 0.9, reasons: ['SAME_ADDRESS'] }],
};

describe('Property 3: Öffentliche Projektion mit Objektmerkmalen', () => {
  it('delivers exactly the stored merkmale and never a Markierung', () => {
    fc.assert(
      fc.property(arbListing(), fc.boolean(), (listing, flagged) => {
        const management: ListingManagement = {
          status: 'ACTIVE',
          agencyId: 'agy-1',
          origin: 'MANUAL',
          version: 1,
          contentHash: '0'.repeat(64),
          fieldSources: {},
          updatedAt: '2026-01-01T00:00:00.000Z',
          createdAt: '2026-01-01T00:00:00.000Z',
          ...(flagged && { flags: [flag] }),
        };
        const item = toManagedListingItem(listing, management);
        const projected = fromListingItem(item as unknown as Record<string, unknown>);
        const version = {
          title: listing.title,
          description: listing.description,
          deliveredLocale: listing.originalLocale,
        };
        const delivered = serialize(projected, { taxonomy, version }) as Record<string, unknown>;

        expect(LocalizedListing.safeParse(delivered).success).toBe(true);
        for (const key of MANAGEMENT_KEYS) expect(delivered).not.toHaveProperty(key);
        for (const key of MERKMALE) {
          expect(Object.hasOwn(delivered, key)).toBe(listing[key] !== undefined);
        }
        const address = delivered['address'] as Record<string, unknown>;
        expect(Object.hasOwn(address, 'houseNumber')).toBe(
          listing.address.houseNumber !== undefined,
        );
        expect(Object.hasOwn(address, 'unit')).toBe(listing.address.unit !== undefined);
      }),
      { numRuns: 100 },
    );
  });
});
