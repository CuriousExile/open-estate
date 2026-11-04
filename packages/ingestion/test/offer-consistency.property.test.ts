// Feature: real-estate-platform, Property 12: Angebots-Konsistenz
import {
  formatDecimal,
  LISTING_BOUNDS as B,
  type Offer,
  type OfferType,
} from '@open-estate/shared';
import fc from 'fast-check';
import {
  arbCurrency,
  arbListing,
  arbMoneyMinor,
  arbRentOffer,
  arbSaleOffer,
} from '../../shared/test/arbitraries';
import {
  covers,
  expectedStored,
  setupImport,
  toInput,
  toInputOffer,
  type Obj,
} from './support/import-harness';

/**
 * Property 12: a candidate is rejected iff an offer rule is violated — no offer, more than two
 * offers, a code ∉ {SALE, RENT}, two offers of the same type, a SALE offer with additional costs
 * or warm rent, a RENT offer with warmRent < coldRent or a deviating currency within an offer —
 * and the log names every affected field.
 *
 * Strategy: an otherwise valid listing from `arbListing` whose offer list is replaced by 0–4
 * offers, each either valid (SALE or RENT) or carrying one offer-rule violation. A model derives
 * the expected field paths from the generated offers:
 * - 0 or ≥ 3 offers ⇒ `offers` only. The length check wins: Zod reports `too_big`/`too_small`
 *   on `offers` and nothing for the elements, and `offers` names the whole list.
 * - otherwise the element violations (`offers.i.<field>`) plus `offers` if two offers share an
 *   offer type (duplicates are detected on the type alone, even if such an offer is invalid).
 *
 * „Abweichende Währung innerhalb eines Angebots“: an offer has a single `currency` that applies to
 * all of its amounts, so a deviating currency cannot be expressed through the schema's fields. It
 * is modelled as an additional per-amount currency field (e.g. `warmRentCurrency`), which the
 * strict offer schema rejects as `unrecognized_keys` naming that field.
 *
 * Valid candidates cover SALE only, RENT only and SALE + RENT (both orders).
 *
 * **Validates: Requirements 12.1, 12.3, 12.4, 12.5, 12.11, 12.14**
 */

const RUN_ID = 'run-12';

interface OfferCase {
  readonly name: string;
  /** Internal offer, used to build the expected stored listing when the candidate is valid. */
  readonly offer: Offer;
  /** Offer type relevant for the duplicate check; `undefined` for an unknown/missing code. */
  readonly type: OfferType | undefined;
  /** Builds the input offer and returns the violated field names relative to the offer. */
  readonly build: () => { input: Obj; violations: string[] };
  readonly [fc.toStringMethod]: () => string;
}

const offerCase = (
  name: string,
  offer: Offer,
  type: OfferType | undefined,
  mutate: (input: Obj) => string[] = () => [],
): OfferCase => ({
  name,
  offer,
  type,
  build: () => {
    const input = toInputOffer(offer);
    return { input, violations: mutate(input) };
  },
  [fc.toStringMethod]: () => `${name} ${JSON.stringify(toInputOffer(offer))}`,
});

const arbOfferInput: fc.Arbitrary<Offer> = fc.oneof(arbSaleOffer, arbRentOffer);
const arbAmount = arbMoneyMinor.map(formatDecimal);

/** Req 12.11: missing offer type or a code other than SALE/RENT. */
const arbUnknownCode = fc
  .tuple(arbOfferInput, fc.constantFrom<unknown>(undefined, 'sale', 'rent', 'LEASE', '', 1))
  .map(([offer, code]) =>
    offerCase(`offerType = ${String(JSON.stringify(code))}`, offer, undefined, (input) => {
      if (code === undefined) delete input['offerType'];
      else input['offerType'] = code;
      return ['offerType'];
    }),
  );

/** Req 12.5: SALE offer with additional costs and/or warm rent. */
const arbSaleWithRentFields = fc
  .tuple(
    arbSaleOffer,
    fc
      .record({ additionalCosts: arbAmount, warmRent: arbAmount }, { requiredKeys: [] })
      .filter((extra) => Object.keys(extra).length > 0),
  )
  .map(([offer, extra]) =>
    offerCase(`SALE with ${Object.keys(extra).join(' + ')}`, offer, 'SALE', (input) => {
      Object.assign(input, extra);
      return Object.keys(extra);
    }),
  );

/** Req 12.4: RENT offer with warmRent < coldRent. */
const arbRentWarmBelowCold = arbRentOffer
  .filter((offer) => offer.coldRent > B.money.minMinor)
  .chain((offer) =>
    fc.integer({ min: B.money.minMinor, max: offer.coldRent - 1 }).map((warm) =>
      offerCase('RENT with warmRent < coldRent', offer, 'RENT', (input) => {
        input['warmRent'] = formatDecimal(warm);
        return ['warmRent'];
      }),
    ),
  );

/** Req 12.3: a currency for one amount that deviates from the offer currency. */
const arbRentForeignCurrency = fc
  .tuple(
    arbRentOffer,
    fc.constantFrom('coldRentCurrency', 'additionalCostsCurrency', 'warmRentCurrency'),
    arbCurrency,
  )
  .filter(([offer, , currency]) => currency !== offer.currency)
  .map(([offer, key, currency]) =>
    offerCase(`RENT with ${key}`, offer, 'RENT', (input) => {
      input[key] = currency;
      return [key];
    }),
  );

const arbValidOffer: fc.Arbitrary<OfferCase> = fc.oneof(
  arbSaleOffer.map((o) => offerCase('valid SALE', o, 'SALE')),
  arbRentOffer.map((o) => offerCase('valid RENT', o, 'RENT')),
);

const arbInvalidOffer: fc.Arbitrary<OfferCase> = fc.oneof(
  arbUnknownCode,
  arbSaleWithRentFields,
  arbRentWarmBelowCold,
  arbRentForeignCurrency,
);

const arbOfferCase: fc.Arbitrary<OfferCase> = fc.oneof(
  { arbitrary: arbValidOffer, weight: 2 },
  { arbitrary: arbInvalidOffer, weight: 1 },
);

/** 0–4 offers; 1–2 most of the time so element and duplicate rules are exercised. */
const arbOfferCases: fc.Arbitrary<OfferCase[]> = fc.oneof(
  { arbitrary: fc.array(arbOfferCase, { minLength: 1, maxLength: 2 }), weight: 4 },
  { arbitrary: fc.constant<OfferCase[]>([]), weight: 1 },
  { arbitrary: fc.array(arbOfferCase, { minLength: 3, maxLength: 4 }), weight: 1 },
);

/** Model: field paths an offer list violates (empty ⇔ valid). */
function expectedFields(cases: readonly OfferCase[], violations: readonly string[][]): string[] {
  if (cases.length < B.offers.min || cases.length > B.offers.max) return ['offers'];
  const fields = violations.flatMap((fs, i) => fs.map((f) => `offers.${i}.${f}`));
  const types = cases.flatMap((c) => (c.type === undefined ? [] : [c.type]));
  if (new Set(types).size < types.length) fields.push('offers');
  return fields;
}

describe('Property 12: Angebots-Konsistenz', () => {
  it('rejects exactly the candidates violating an offer rule and names every affected field', async () => {
    await fc.assert(
      fc.asyncProperty(arbListing(), arbOfferCases, async (listing, cases) => {
        const built = cases.map((c) => c.build());
        const input = structuredClone(toInput(listing));
        input['offers'] = built.map((b) => b.input);
        const expected = expectedFields(
          cases,
          built.map((b) => b.violations),
        );
        const t = setupImport(RUN_ID);

        const outcome = await t.process(input);

        if (expected.length === 0) {
          expect(outcome).toBe('imported');
          expect(t.writes()).toBe(1);
          const stored = { ...listing, offers: cases.map((c) => c.offer) };
          expect(t.store.get(listing.id)).toEqual(expectedStored(stored, RUN_ID));
          expect(t.rejectedFields()).toEqual([]);
          return;
        }

        expect(outcome).toBe('rejected');
        expect(t.writes()).toBe(0);
        expect(t.store.get(listing.id)).toBeUndefined();
        const logged = t.rejectedFields();
        // Every affected field is named …
        expect(expected.filter((field) => !logged.some((l) => covers(l, field)))).toEqual([]);
        // … nothing outside `offers` …
        expect(logged.filter((l) => !covers(l, 'offers'))).toEqual([]);
        // … and nothing beyond the modelled violations.
        expect(logged.filter((l) => !expected.some((field) => covers(l, field)))).toEqual([]);
      }),
      { numRuns: 100 },
    );
  });
});
