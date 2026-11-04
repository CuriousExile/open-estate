// Feature: real-estate-platform, Property 32: Vollständiges Listing-Rendering
import fc from 'fast-check';
import {
  assertValidTaxonomy,
  DEFAULT_TAXONOMY_CONFIG,
  serialize,
  type Listing,
  type LocalizedListing,
  type OfferType,
} from '@open-estate/shared';
import {
  arbListing,
  arbLocalizedVersion,
  OFFER_TYPE_COMBINATIONS,
} from '../../shared/test/arbitraries';
import { toListingDetail, type OfferAmountKey } from '../src/app/listing/listing-detail-model';
import { formatMoney, formatNumber } from '../src/app/listing/listing-format';
import { toResultRow } from '../src/app/results/result-list-model';

/**
 * Property 32: for any listing (SALE only, RENT only, SALE + RENT) the result row contains title,
 * offer type, city, price with currency, rooms, area and listing type; the detail view shows for
 * every RENT offer the cold rent, plus additional costs and warm rent exactly if they are stored.
 *
 * Inputs are internal listings from the shared generators, converted to the API representation
 * with `serialize`. The shown offer is chosen independently on the internal listing (index of
 * the filtered offer type, else the first offer), so the expectation does not reuse `selectOffer`.
 *
 * **Validates: Requirements 7.4, 12.13**
 */

const taxonomy = assertValidTaxonomy(DEFAULT_TAXONOMY_CONFIG);
const LOCALES = ['de', 'en', 'fr', 'pt-BR'] as const;

interface Input {
  readonly internal: Listing;
  readonly listing: LocalizedListing;
  readonly locale: string;
  readonly filter: OfferType | undefined;
}

const arbInput: fc.Arbitrary<Input> = arbListing({ offerTypes: OFFER_TYPE_COMBINATIONS }).chain(
  (internal) =>
    fc.record({
      internal: fc.constant(internal),
      listing: arbLocalizedVersion(internal).map((version) =>
        serialize(internal, { taxonomy, version }),
      ),
      locale: fc.constantFrom(...LOCALES),
      filter: fc.constantFrom<OfferType | undefined>('SALE', 'RENT', undefined),
    }),
);

describe('Property 32: Vollständiges Listing-Rendering', () => {
  it('renders all row fields and every stored offer amount', () => {
    fc.assert(
      fc.property(arbInput, ({ internal, listing, locale, filter }) => {
        // Result row (Req 7.4).
        const row = toResultRow(listing, filter, locale);
        const matching = internal.offers.findIndex((o) => o.offerType === filter);
        const shownIndex = matching === -1 ? 0 : matching;
        const shown = listing.offers[shownIndex];
        expect(shown).toBeDefined();
        if (shown === undefined) return;
        const amount = shown.offerType === 'SALE' ? shown.price : shown.coldRent;

        expect(row.title).toBe(listing.title);
        expect(row.title.length).toBeGreaterThan(0);
        expect(row.offerType).toBe(internal.offers[shownIndex]?.offerType);
        if (matching !== -1) expect(row.offerType).toBe(filter);
        expect(row.city).toBe(internal.address.city);
        expect(row.price).toBe(formatMoney(amount, shown.currency, locale));
        expect(row.price?.length).toBeGreaterThan(0);
        expect(row.rooms).toBe(formatNumber(internal.rooms, locale));
        expect(row.area).toBe(formatNumber(listing.area, locale));
        expect(row.listingType).toBe(internal.listingType);

        // Detail view: all offers in stored order with their stored amounts (Req 12.13).
        const detail = toListingDetail(listing, locale);
        expect(detail.offers.map((o) => o.offerType)).toEqual(
          internal.offers.map((o) => o.offerType),
        );
        listing.offers.forEach((offer, i) => {
          const expected: (readonly [OfferAmountKey, string])[] =
            offer.offerType === 'SALE'
              ? [['detail.offer.price', offer.price]]
              : [
                  ['detail.offer.coldRent', offer.coldRent],
                  ...(offer.additionalCosts !== undefined
                    ? [['detail.offer.additionalCosts', offer.additionalCosts] as const]
                    : []),
                  ...(offer.warmRent !== undefined
                    ? [['detail.offer.warmRent', offer.warmRent] as const]
                    : []),
                ];
          const internalOffer = internal.offers[i];
          if (internalOffer?.offerType === 'RENT') {
            expect(expected.length).toBe(
              1 +
                Number(internalOffer.additionalCosts !== undefined) +
                Number(internalOffer.warmRent !== undefined),
            );
          }
          expect(detail.offers[i]?.amounts).toEqual(
            expected.map(([key, value]) => ({
              key,
              value: formatMoney(value, offer.currency, locale),
            })),
          );
        });
      }),
      { numRuns: 100 },
    );
  });
});
