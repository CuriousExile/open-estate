// Feature: duplicate-detection, Property 21: Keine Klarwerte
import { ImportPipeline, InMemoryImportStore, createRunLogger } from '@open-estate/ingestion';
import { buildSchemas, TourProvidersConfig } from '@open-estate/shared';
import fc from 'fast-check';
import { TAXONOMY } from '../../shared/test/arbitraries/duplicates';
import { duplicatePlatform, member } from '../../core/test/duplicates/support/duplicate-harness';

/**
 * For any listing with street, unit, parcel id, source and media URLs, title, description and
 * contact data, and any sequence of creations (with and without Idempotenzschlüssel), edits,
 * releases, dismissals and imports: no entry of the Duplikat_Index, no Idempotenzschlüssel
 * record, no Agenturübergreifender_Treffer, no audit entry, no Markierung, no log line of the
 * Duplikat_Abgleich and no line of the import run log contains one of these
 * values, nor any part of them of 3 or more characters.
 *
 * The values are built from the letters `j k q v w x z` only: they are not hex digits, so they
 * cannot occur by chance in the hashes and signatures the index stores, and no three of them
 * follow each other in the field names, codes and identifiers around them. Comparison is
 * case-insensitive, because the index normalizes. House numbers are digits, which hashes and timestamps contain anyway, so they are
 * covered by the street hash but not checked as text here.
 *
 * **Validates: Requirements 5.5, 7.7, 10.7, 12.1, 12.2**
 */

/** Random words from letters that occur neither in hex output nor as triples in the stored structure. */
const arbSecretWord = fc.stringMatching(/^[jkqvwxz]{6,10}$/);

const arbSecrets = fc.record({
  street: arbSecretWord,
  unit: arbSecretWord,
  parcel: arbSecretWord,
  site: arbSecretWord,
  image: arbSecretWord,
  title: arbSecretWord,
  description: arbSecretWord,
  name: arbSecretWord,
});

type Secrets = Record<
  'street' | 'unit' | 'parcel' | 'site' | 'image' | 'title' | 'description' | 'name',
  string
>;

function contentWith(secrets: Secrets, variant: number): Record<string, unknown> {
  return {
    originalLocale: 'de',
    title: `${secrets.title} Wohnung`,
    description: `Sehr ${secrets.description} gelegen`,
    translations: [],
    offers: [{ offerType: 'SALE', price: `${250000 + variant}.00`, currency: 'EUR' }],
    listingType: 'apartment_unit',
    rooms: 3,
    area: '80.00',
    address: {
      city: 'Berlin',
      postalCode: '10115',
      country: 'DE',
      street: `${secrets.street}strasse 12`,
      unit: `Whg ${secrets.unit}`,
    },
    sourceUrl: `https://${secrets.site}.example/objekt`,
    media: [{ url: `https://cdn.example/${secrets.image}.jpg` }],
    tours: [],
    parcelId: `Flur ${secrets.parcel}`,
    contact: { name: secrets.name },
  };
}

/** Every substring of length 3 of every secret, lower case. */
const fragments = (secrets: Secrets): string[] =>
  Object.values(secrets).flatMap((value) =>
    Array.from({ length: value.length - 2 }, (_, i) => value.slice(i, i + 3).toLowerCase()),
  );

const listingSchema = buildSchemas(TAXONOMY, {
  defaultLocale: 'de',
  enabled: [{ locale: 'de', label: 'Deutsch' }],
}).listing;

describe('Property 21: Keine Klarwerte', () => {
  it('keeps every value out of index, idempotency records, audit, flags and run log', async () => {
    await fc.assert(
      fc.asyncProperty(arbSecrets, fc.integer({ min: 1, max: 3 }), async (secrets, copies) => {
        // Management_API: creations (one with a key), an edit, a release and a dismissal.
        const platform = duplicatePlatform();
        const agent = member('agy-a');
        const ids: string[] = [];
        for (let i = 0; i < copies + 1; i += 1) {
          const result =
            i === 0
              ? await platform.commands.createWithKey(
                  agent,
                  { content: contentWith(secrets, i) },
                  `k-${secrets.title}`,
                )
              : await platform.commands.create(agent, { content: contentWith(secrets, i) });
          if (result.ok) ids.push('view' in result.value ? result.value.view.id : result.value.id);
        }
        const [first, second] = ids;
        if (first !== undefined) {
          const current = await platform.get(first);
          await platform.commands.replaceContent(agent, first, {
            content: contentWith(secrets, 99),
            baseVersion: current?.management.version ?? 1,
          });
        }
        if (second !== undefined) {
          await platform.commands.setStatus(agent, second, { status: 'ACTIVE' });
          await platform.commands.dismissFlag(agent, second, 'DUPLICATE');
        }

        // The same property at another agency, then the Duplikat_Abgleich: an
        // Agenturübergreifender_Treffer, Markierungen set by the system actor, a run log line.
        await platform.commands.create(member('agy-b'), { content: contentWith(secrets, 0) });
        const sweepLog = await platform.sweep();

        // Import: two records of the same property, so one is flagged and logged.
        const lines: string[] = [];
        const store = new InMemoryImportStore({ duplicates: { taxonomy: TAXONOMY } });
        const pipeline = new ImportPipeline({
          listingSchema,
          reader: store.reader,
          writer: store.writer,
          tourProviders: TourProvidersConfig.parse({ providers: [] }),
          taxonomy: TAXONOMY,
          ...(store.detector !== undefined && { duplicates: store.detector }),
        });
        const logger = createRunLogger({
          runId: 'run-1',
          source: 'feed',
          sink: (l) => lines.push(l),
        });
        for (const id of ['imp-1', 'imp-2']) {
          await pipeline.process(
            { ...contentWith(secrets, 0), id },
            { runId: 'run-1', source: 'feed', logger },
          );
        }

        const stored = JSON.stringify({
          index: platform.index.snapshot(),
          idempotency: platform.idempotency.entries(),
          audit: platform.audit.entries,
          flags: (await platform.all()).map((l) => l.management.flags ?? []),
          reports: platform.reports.all(),
          sweepLog,
          importIndex: store.duplicateIndex.snapshot(),
          importFlags: store.listings.all().map((item) => item.flags ?? []),
          runLog: lines,
        }).toLowerCase();
        for (const fragment of fragments(secrets)) expect(stored).not.toContain(fragment);
      }),
      { numRuns: 100 },
    );
  });
});
