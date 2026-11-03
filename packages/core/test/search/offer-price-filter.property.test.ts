// Feature: real-estate-platform, Property 2: Angebotsart- und Preisfilter wirken je Angebot und Währung
import { createSearchService, InMemorySearchProvider } from '@open-estate/core';
import {
  assertValidTaxonomy,
  buildSchemas,
  DEFAULT_TAXONOMY_CONFIG,
  formatDecimal,
  parseSearchQuery,
  type Listing,
  type Offer,
  type OfferType,
  type TourProvidersConfig,
} from '@open-estate/shared';
import fc from 'fast-check';
import {
  arbMoneyMinor,
  exampleListing,
  OFFER_TYPE_COMBINATIONS,
} from '../../../shared/test/arbitraries';

/**
 * Property 2: for any stock of listings with 1–2 offers (SALE only, RENT only, SALE + RENT) and
 * any request with `offerType` t (optionally price range [a, b] and currency c), a listing is
 * delivered iff it has an offer of type t and — with a price filter — that offer's relevant amount
 * (sale price resp. cold rent) lies in [a, b] and its currency equals c, or the default currency
 * without c. Offers of the other type do not influence the result.
 *
 * Requests go through `parseSearchQuery` (decimal strings, as at the API) and all pages are
 * collected, so the check covers the full result set.
 *
 * **Validates: Requirements 12.6, 12.7, 12.9**
 */

const taxonomy = assertValidTaxonomy(DEFAULT_TAXONOMY_CONFIG);
const schemas = buildSchemas(taxonomy, {
  defaultLocale: 'de',
  enabled: [{ locale: 'de', label: 'Deutsch' }],
});
const noTours: TourProvidersConfig = { providers: [] };

/** Small pool so request and offer currencies collide often. */
const CURRENCIES = ['EUR', 'CHF', 'USD'] as const;
const arbCurrency = fc.constantFrom(...CURRENCIES);

/** Mostly small amounts (frequent overlap with bounds), sometimes the full money range. */
const arbAmount = fc.oneof(fc.integer({ min: 1, max: 1_000 }), arbMoneyMinor);

const arbSale: fc.Arbitrary<Offer> = fc.record({
  offerType: fc.constant('SALE' as const),
  price: arbAmount,
  currency: arbCurrency,
});

/** Additional costs / warm rent vary but must not influence the filter (cold rent is decisive). */
const arbRent: fc.Arbitrary<Offer> = fc
  .record({
    coldRent: arbAmount,
    currency: arbCurrency,
    additionalCosts: fc.option(arbAmount, { nil: undefined }),
    warmExtra: fc.option(fc.integer({ min: 0, max: 1_000 }), { nil: undefined }),
  })
  .map(({ coldRent, currency, additionalCosts, warmExtra }) => ({
    offerType: 'RENT' as const,
    coldRent,
    currency,
    ...(additionalCosts !== undefined && { additionalCosts }),
    ...(warmExtra !== undefined && { warmRent: coldRent + warmExtra }),
  }));

const arbOffers: fc.Arbitrary<Offer[]> = fc
  .constantFrom(...OFFER_TYPE_COMBINATIONS)
  .chain((types) => fc.tuple(...types.map((t) => (t === 'SALE' ? arbSale : arbRent))));

const arbStock: fc.Arbitrary<Listing[]> = fc
  .array(arbOffers, { maxLength: 30 })
  .map((offerLists) =>
    offerLists.map((offers, i) => exampleListing(`id-${String(i).padStart(3, '0')}`, { offers })),
  );

const relevantAmount = (offer: Offer): number =>
  offer.offerType === 'SALE' ? offer.price : offer.coldRent;

interface Request {
  offerType: OfferType;
  priceMin?: number;
  priceMax?: number;
  currency?: string;
}

/** Independent reference predicate, written directly from the property text. */
function expectedMatch(listing: Listing, req: Request, defaultCurrency: string): boolean {
  const offer = listing.offers.find((o) => o.offerType === req.offerType);
  if (offer === undefined) return false;
  if (req.priceMin === undefined && req.priceMax === undefined) return true;
  const amount = relevantAmount(offer);
  return (
    (req.priceMin === undefined || amount >= req.priceMin) &&
    (req.priceMax === undefined || amount <= req.priceMax) &&
    offer.currency === (req.currency ?? defaultCurrency)
  );
}

/** Bounds are often taken from amounts present in the stock, so inclusive edges are hit. */
function arbRequest(stock: readonly Listing[]): fc.Arbitrary<Request> {
  const amounts = stock.flatMap((l) => l.offers.map(relevantAmount));
  const arbBound =
    amounts.length > 0 ? fc.oneof(arbAmount, fc.constantFrom(...amounts)) : arbAmount;
  return fc
    .record(
      {
        offerType: fc.constantFrom<OfferType>('SALE', 'RENT'),
        min: arbBound,
        max: arbBound,
        currency: arbCurrency,
      },
      { requiredKeys: ['offerType'] },
    )
    .map(({ offerType, min, max, currency }) => {
      // Min > Max is rejected by parseSearchQuery (Req 1.10), so order the bounds.
      const [lo, hi] =
        min !== undefined && max !== undefined && min > max ? [max, min] : [min, max];
      return {
        offerType,
        ...(lo !== undefined && { priceMin: lo }),
        ...(hi !== undefined && { priceMax: hi }),
        ...(currency !== undefined && { currency }),
      };
    });
}

/** Runs the request through the API input format and returns the ids of all pages. */
async function searchAllIds(
  stock: Listing[],
  req: Request,
  defaultCurrency: string,
  pageSize: number,
): Promise<string[]> {
  const service = createSearchService({
    provider: new InMemorySearchProvider(stock),
    taxonomy,
    tourProviders: noTours,
    defaultCurrency,
  });
  const raw: Record<string, unknown> = {
    offerType: req.offerType,
    pageSize: String(pageSize),
    ...(req.priceMin !== undefined && { priceMin: formatDecimal(req.priceMin) }),
    ...(req.priceMax !== undefined && { priceMax: formatDecimal(req.priceMax) }),
    ...(req.currency !== undefined && { currency: req.currency }),
  };

  const ids: string[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page <= stock.length; page++) {
    const parsed = parseSearchQuery({ ...raw, ...(pageToken && { pageToken }) }, schemas);
    if (!parsed.ok) throw new Error(`query rejected: ${JSON.stringify(parsed.error)}`);
    const result = await service.search(parsed.value, []);
    if (!result.ok) throw new Error(`search failed: ${JSON.stringify(result.error)}`);
    ids.push(...result.value.items.map((l) => l.id));
    pageToken = result.value.nextPageToken;
    if (pageToken === undefined) return ids;
  }
  throw new Error('pagination did not terminate');
}

describe('Property 2: Angebotsart- und Preisfilter wirken je Angebot und Währung', () => {
  it('delivers exactly the listings whose offer of the requested type matches price and currency', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbStock.chain((stock) =>
          fc.tuple(
            fc.constant(stock),
            arbRequest(stock),
            arbCurrency,
            fc.integer({ min: 1, max: 50 }),
          ),
        ),
        async ([stock, req, defaultCurrency, pageSize]) => {
          const actual = await searchAllIds(stock, req, defaultCurrency, pageSize);
          const expected = stock
            .filter((l) => expectedMatch(l, req, defaultCurrency))
            .map((l) => l.id)
            .sort();
          expect([...actual].sort()).toEqual(expected);
          expect(new Set(actual).size).toBe(actual.length);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('finds a SALE + RENT listing in matching searches for SALE and for RENT', async () => {
    const arbDual = fc
      .tuple(arbSale, arbRent, fc.boolean(), arbStock)
      .map(([sale, rentOffer, saleFirst, others]) => ({
        dual: exampleListing('dual', { offers: saleFirst ? [sale, rentOffer] : [rentOffer, sale] }),
        others,
      }));

    await fc.assert(
      fc.asyncProperty(
        arbDual,
        arbCurrency,
        fc.boolean(),
        async ({ dual, others }, defaultCurrency, explicitCurrency) => {
          const stock = [dual, ...others];
          for (const offer of dual.offers) {
            const amount = relevantAmount(offer);
            // Without explicit currency the filter only matches if the offer is in the default one.
            const useExplicit = explicitCurrency || offer.currency !== defaultCurrency;
            const priced: Request = {
              offerType: offer.offerType,
              priceMin: amount,
              priceMax: amount,
              ...(useExplicit && { currency: offer.currency }),
            };
            await expect(
              searchAllIds(stock, { offerType: offer.offerType }, defaultCurrency, 50),
            ).resolves.toContain('dual');
            await expect(searchAllIds(stock, priced, defaultCurrency, 50)).resolves.toContain(
              'dual',
            );
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
