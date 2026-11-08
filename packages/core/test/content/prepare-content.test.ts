import {
  bindAttributes,
  contentRules,
  prepareContent,
  TOUR_HOST_NOT_ALLOWED,
  toFieldIssues,
} from '@open-estate/core';
import { assertValidTaxonomy, Contact, Media, PII_FIELD_PATHS, Tour } from '@open-estate/shared';
import fc from 'fast-check';
import { z } from 'zod';

// Small schema with the real contact/media/tour parts; the full listing schema is covered by the
// import pipeline tests in `@open-estate/ingestion`.
const schema = z.strictObject({
  id: z.string(),
  rooms: z.number().min(1),
  contact: Contact.optional(),
  media: z.array(Media),
  tours: z.array(Tour),
});

const rules = contentRules({
  piiAllowlist: { allowedFields: ['contact.name'] },
  tourProviders: { providers: [{ code: 'matterport', hostnames: ['my.matterport.com'] }] },
});

const CONTACT = { name: 'A. Agent', phone: '+49 30 123', email: 'agent@example.org' };

describe('prepareContent', () => {
  it('filters PII, cleans media/tours and returns the validated content', () => {
    const input = {
      id: 'l-1',
      rooms: 3,
      contact: CONTACT,
      media: [{ url: 'https://img.example.org/1.jpg' }, { url: 'http://img.example.org/2.jpg' }],
      tours: [
        { url: 'https://my.matterport.com/show/?m=1', providerCode: 'ignored' },
        { url: 'https://tours.example.org/2' },
      ],
    };

    const result = prepareContent(input, schema, rules);

    expect(result).toEqual({
      ok: true,
      content: {
        id: 'l-1',
        rooms: 3,
        contact: { name: 'A. Agent' },
        media: [{ url: 'https://img.example.org/1.jpg' }],
        tours: [{ url: 'https://my.matterport.com/show/?m=1', providerCode: 'matterport' }],
      },
      droppedPii: ['contact.phone', 'contact.email'],
      droppedAttributes: [],
      mediaDrops: [
        { kind: 'media', index: 1, reason: 'URL scheme is not https' },
        {
          kind: 'tour',
          index: 1,
          reason: TOUR_HOST_NOT_ALLOWED,
          url: 'https://tours.example.org/2',
        },
      ],
      mediaTruncations: [],
    });
    expect(input.contact).toEqual(CONTACT);
  });

  it('defaults missing media and tour lists to empty lists', () => {
    const result = prepareContent({ id: 'l-2', rooms: 1 }, schema, rules);
    expect(result).toMatchObject({ ok: true, content: { media: [], tours: [] } });
  });

  it('drops every PII field without an allow-list', () => {
    const noPii = contentRules({ tourProviders: { providers: [] } });
    const result = prepareContent({ id: 'l-3', rooms: 1, contact: CONTACT }, schema, noPii);
    expect(result).toMatchObject({ ok: true, content: { contact: {} } });
    expect(result.droppedPii).toEqual(['contact.name', 'contact.phone', 'contact.email']);
  });

  it('returns all field issues and still reports the drops', () => {
    const result = prepareContent(
      { id: 7, rooms: 0, contact: { phone: 1 }, media: 'none', extra: true },
      schema,
      rules,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.field).sort()).toEqual([
      'extra',
      'id',
      'media',
      'rooms',
    ]);
    // An invalid but dropped PII value causes no issue.
    expect(result.droppedPii).toEqual(['contact.phone']);
  });

  it('reports truncated media beyond the limit', () => {
    const media = Array.from({ length: 52 }, (_, i) => ({ url: `https://img.example.org/${i}` }));
    const result = prepareContent({ id: 'l-4', rooms: 1, media }, schema, rules);
    expect(result.mediaTruncations).toEqual([{ kind: 'media', droppedCount: 2 }]);
    expect(result).toMatchObject({ ok: true, content: { media: media.slice(0, 50) } });
  });

  it('keeps no non-allow-listed PII field and names every dropped one', () => {
    const arbAllowed = fc.subarray([...PII_FIELD_PATHS]);
    const arbContact = fc.record(
      { name: fc.string(), phone: fc.string(), email: fc.string() },
      { requiredKeys: [] },
    );
    fc.assert(
      fc.property(arbAllowed, arbContact, (allowed, contact) => {
        const custom = contentRules({
          piiAllowlist: { allowedFields: allowed },
          tourProviders: { providers: [] },
        });
        const result = prepareContent({ id: 'l', rooms: 1, contact }, schema, custom);
        const expectedDropped = PII_FIELD_PATHS.filter(
          (path) =>
            !allowed.includes(path) && Object.hasOwn(contact, path.slice('contact.'.length)),
        );
        expect(result.droppedPii).toEqual(expectedDropped);
        const kept = Object.keys(Object(result.ok ? result.content.contact : {}));
        kept.forEach((key) => expect(allowed).toContain(`contact.${key}`));
      }),
    );
  });
});

describe('toFieldIssues', () => {
  it('splits unrecognized keys into one issue per field and names root issues `record`', () => {
    const strict = z.strictObject({ a: z.number() });
    const issuesOf = (value: unknown) => strict.safeParse(value).error?.issues ?? [];
    expect(toFieldIssues(issuesOf({ a: 1, b: 2, c: 3 }))).toEqual([
      { field: 'b', reason: 'Unrecognized field' },
      { field: 'c', reason: 'Unrecognized field' },
    ]);
    expect(toFieldIssues(issuesOf(null))).toEqual([
      { field: 'record', reason: expect.any(String) },
    ]);
  });
});

// Merkmalsbindung (duplicate-detection Req 2.5).
describe('prepareContent: Objektmerkmale per property group', () => {
  const taxonomy = assertValidTaxonomy({
    groups: [
      { code: 'apartment', types: ['loft'], attributes: ['floor', 'address.unit'] },
      { code: 'land', types: ['plot'], attributes: ['plotArea'] },
    ],
  });
  const bound = contentRules({ tourProviders: { providers: [] }, taxonomy });
  const attributeSchema = z.object({
    listingType: z.string(),
    address: z.object({ city: z.string(), unit: z.string().optional() }),
    floor: z.number().optional(),
    plotArea: z.string().optional(),
    media: z.array(Media),
    tours: z.array(Tour),
  });

  it('keeps allowed merkmale and drops the others, naming them without values', () => {
    const input = {
      listingType: 'plot',
      address: { city: 'Kiel', unit: 'Whg. 3' },
      floor: 2,
      plotArea: '500.00',
    };
    const result = prepareContent(input, attributeSchema, bound);

    expect(result).toMatchObject({
      ok: true,
      content: { listingType: 'plot', address: { city: 'Kiel' }, plotArea: '500.00' },
    });
    expect(result.ok && 'floor' in result.content).toBe(false);
    expect(result.droppedAttributes).toEqual(['address.unit', 'floor']);
    // The input is not modified.
    expect(input.address.unit).toBe('Whg. 3');
  });

  it('keeps everything allowed for the group and drops nothing', () => {
    const result = prepareContent(
      { listingType: 'loft', address: { city: 'Kiel', unit: '3' }, floor: 4 },
      attributeSchema,
      bound,
    );
    expect(result).toMatchObject({ ok: true, content: { address: { unit: '3' }, floor: 4 } });
    expect(result.droppedAttributes).toEqual([]);
  });

  it('leaves a listing type outside the taxonomy to the schema', () => {
    const result = bindAttributes({ listingType: 'castle', floor: 4 }, taxonomy);
    expect(result).toEqual({ candidate: { listingType: 'castle', floor: 4 }, dropped: [] });
  });

  it('drops nothing without a taxonomy', () => {
    expect(bindAttributes({ listingType: 'plot', floor: 4 }, undefined).dropped).toEqual([]);
  });
});
