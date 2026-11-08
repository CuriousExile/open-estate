// Feature: duplicate-detection, Property 24: Portal-Formular und Bindung
import {
  assertValidTaxonomy,
  BINDABLE_ATTRIBUTES,
  type BindableAttribute,
  type NestedTaxonomyConfig,
} from '@open-estate/shared';
import fc from 'fast-check';
import {
  emptyFormValues,
  emptyOffer,
  requestBody,
  validateListingForm,
  visibleAttributes,
  type AttributeValues,
  type ListingFormValues,
} from '../src/app/portal/listings/listing-form-model';

/**
 * For any taxonomy and any sequence of type changes in the form, the form shows exactly the
 * Objektmerkmale allowed for the group of the current type, and the request it sends contains no
 * Objektmerkmal that is not allowed — values typed for another type stay in the form, unsent.
 *
 * **Validates: Requirements 2.7**
 */

const arbTaxonomyConfig: fc.Arbitrary<NestedTaxonomyConfig> = fc
  .uniqueArray(fc.stringMatching(/^[a-z]{2,8}$/), { minLength: 2, maxLength: 8 })
  .chain((codes) =>
    fc.integer({ min: 1, max: Math.max(1, codes.length - 1) }).chain((groupCount) =>
      fc
        .array(fc.option(fc.subarray([...BINDABLE_ATTRIBUTES]), { nil: undefined }), {
          minLength: groupCount,
          maxLength: groupCount,
        })
        .map((bindings) => ({
          groups: bindings.map((attributes, g) => ({
            code: `g${g}`,
            // Types round-robin over the groups, every group at least one.
            types: codes.filter((_, i) => i % groupCount === g),
            ...(attributes !== undefined && { attributes }),
          })),
        })),
    ),
  );

/** A value for every Objektmerkmal, so everything allowed is sent. */
const FILLED: AttributeValues = {
  unit: 'Whg 3',
  floor: '2',
  totalFloors: '5',
  yearBuilt: '1910',
  plotArea: '420,5',
  bedrooms: '2',
  bathrooms: '1',
  parcelId: 'Flur 3/17',
};

function values(listingType: string): ListingFormValues {
  return {
    ...emptyFormValues({ originalLocale: 'de', currency: 'EUR' }),
    title: 'Altbau',
    listingType,
    offers: [{ ...emptyOffer('SALE'), price: '350000' }],
    rooms: '3',
    area: '90',
    address: { street: 'Hauptstraße 1', postalCode: '10115', city: 'Berlin', country: 'DE' },
    attributes: FILLED,
  };
}

/** Objektmerkmale contained in a request body. */
function sentAttributes(body: Record<string, unknown>): Set<BindableAttribute> {
  const content = body['content'] as Record<string, unknown>;
  const address = content['address'] as Record<string, unknown>;
  return new Set(
    BINDABLE_ATTRIBUTES.filter((attribute) =>
      attribute === 'address.unit'
        ? address['unit'] !== undefined
        : content[attribute] !== undefined,
    ),
  );
}

describe('Property 24: Portal-Formular und Bindung', () => {
  it('shows and sends exactly the Objektmerkmale of the current type’s group', () => {
    fc.assert(
      fc.property(
        arbTaxonomyConfig,
        fc.array(fc.nat(), { minLength: 1, maxLength: 8 }),
        (config, picks) => {
          const taxonomy = assertValidTaxonomy(config);
          const types = taxonomy.groups.flatMap((g) => [...g.types]);
          // Every type, plus no type yet and a type the taxonomy does not know.
          const choices = [...types, '', 'unknown_type'];
          let form = values('');
          for (const pick of picks) {
            const type = choices[pick % choices.length] ?? '';
            const group = taxonomy.groups.find((g) => g.types.includes(type));
            const allowed =
              group === undefined
                ? [...BINDABLE_ATTRIBUTES]
                : BINDABLE_ATTRIBUTES.filter((a) => group.attributes.includes(a));

            // The type change only sets the type; what was typed stays in the form.
            form = { ...form, listingType: type };
            expect(form.attributes).toEqual(FILLED);
            expect(visibleAttributes(taxonomy, type)).toEqual(allowed);
            const sent = sentAttributes(requestBody(form, undefined, taxonomy));
            expect([...sent].sort()).toEqual([...allowed].sort());
            if (group !== undefined) {
              const checked = validateListingForm(form, { taxonomy });
              expect(checked.ok).toBe(true);
              if (checked.ok) expect(sentAttributes(checked.body)).toEqual(sent);
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
