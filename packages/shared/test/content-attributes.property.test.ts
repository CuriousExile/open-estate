// Feature: duplicate-detection, Property 2: Abwärtskompatibler Inhalts_Hash
import fc from 'fast-check';
import {
  canonicalJson,
  changedContentPaths,
  contentHash,
  contentPaths,
  type ListingContent,
} from '../src';
import { sha256Hex } from '../src/sha256';
import { arbAttributes } from './arbitraries/listing';
import { arbListingContent } from './arbitraries/management';

/**
 * For any Listing_Inhalt without Objektmerkmale the Inhalts_Hash equals the hash of a reference
 * implementation over the content fields as they were before this feature: adding optional fields
 * to the schema must not change the hash of existing content (Req 1.9). Adding one merkmal to
 * such a content changes the hash and `changedContentPaths` reports exactly that path, i.e. the
 * merkmale are Inhaltsfelder like every other field (Req 1.4).
 *
 * **Validates: Requirements 1.4, 1.9**
 */

/** Content fields of the listing model before the Objektmerkmale were added. */
const CONTENT_FIELDS_BEFORE = [
  'originalLocale',
  'title',
  'description',
  'translations',
  'offers',
  'listingType',
  'rooms',
  'area',
  'address',
  'geo',
  'sourceUrl',
  'media',
  'tours',
  'contact',
] as const;

/** Address fields before the Objektmerkmale were added. */
const ADDRESS_FIELDS_BEFORE = ['city', 'postalCode', 'country', 'street'] as const;

/** Reference implementation of the Inhalts_Hash as it was before this feature. */
function referenceHash(content: ListingContent): string {
  const source = content as Record<string, unknown>;
  const picked = Object.fromEntries(
    CONTENT_FIELDS_BEFORE.flatMap((field) =>
      source[field] === undefined ? [] : [[field, source[field]]],
    ),
  );
  return sha256Hex(new TextEncoder().encode(canonicalJson(picked) ?? ''));
}

/** Content without any Objektmerkmal, as it could have been stored before this feature. */
const arbContentBefore: fc.Arbitrary<ListingContent> = arbListingContent().map((content) => {
  const source = content as Record<string, unknown>;
  const address = content.address as Record<string, unknown>;
  const legacyAddress = Object.fromEntries(
    ADDRESS_FIELDS_BEFORE.flatMap((field) =>
      address[field] === undefined ? [] : [[field, address[field]]],
    ),
  ) as ListingContent['address'];
  const legacy = Object.fromEntries(
    CONTENT_FIELDS_BEFORE.flatMap((field) =>
      source[field] === undefined ? [] : [[field, source[field]]],
    ),
  ) as ListingContent;
  return { ...legacy, address: legacyAddress };
});

describe('Property 2: Abwärtskompatibler Inhalts_Hash', () => {
  it('keeps the hash of content without Objektmerkmale and treats merkmale as Inhaltsfelder', () => {
    fc.assert(
      fc.property(arbContentBefore, arbAttributes, (before, attributes) => {
        expect(contentHash(before)).toBe(referenceHash(before));
        expect(contentPaths(before)).not.toContain('plotArea');

        // Each merkmal added on its own is exactly one changed Inhaltsfeld.
        for (const [field, value] of Object.entries(attributes)) {
          const after = { ...before, [field]: value } as ListingContent;
          expect(changedContentPaths(before, after)).toEqual([field]);
          expect(contentHash(after)).not.toBe(contentHash(before));
          expect(contentPaths(after)).toContain(field);
        }
        const withHouseNumber = {
          ...before,
          address: { ...before.address, houseNumber: '12a' },
        };
        expect(changedContentPaths(before, withHouseNumber)).toEqual(['address.houseNumber']);
      }),
      { numRuns: 100 },
    );
  });
});
