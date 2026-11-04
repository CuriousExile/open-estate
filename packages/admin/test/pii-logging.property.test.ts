// Feature: real-estate-platform, Property 33: PII-Filter und wertfreies Logging
import { format } from 'node:util';
import { createAdminHandler, type AdminRequest } from '@open-estate/admin';
import { InMemoryApiKeyStore, StaticAccessConfigSource } from '@open-estate/core';
import {
  createRunLogger,
  ImportPipeline,
  InMemoryDeletionBlocklist,
  InMemoryImportStore,
  type RecordProcessingContext,
} from '@open-estate/ingestion';
import {
  assertValidTaxonomy,
  buildSchemas,
  DEFAULT_TAXONOMY_CONFIG,
  LISTING_BOUNDS as B,
  PII_FIELD_PATHS,
  TourProvidersConfig,
  type Listing,
  type PiiAllowlistConfig,
} from '@open-estate/shared';
import fc from 'fast-check';
import {
  expectedStored,
  NOW,
  SOURCE,
  toInput,
  type Input,
} from '../../ingestion/test/support/import-harness';
import { arbListing } from '../../shared/test/arbitraries';
import { createDeletionHarness } from './support/deletion-harness';

/**
 * Property 33: for any candidate and any PII allow-list (missing, empty or a subset of
 * `PII_FIELD_PATHS`) the stored record holds no PII field outside the allow-list, all other
 * fields unchanged, and every dropped field has exactly one log entry with field name, listing
 * id and source; no log or audit entry written during the import or a deletion contains a PII
 * value, not even a substring of 3 characters.
 *
 * Strategy: 1–4 listings with distinct ids, each with an optional contact (any subset of name,
 * phone, email), go through the `ImportPipeline` with the generated allow-list. Then an
 * administrator deletes one listing by id and the rest by source via the admin handler (deletion
 * workflow runs in-process), and finally the same candidates are imported again (now rejected
 * by the deletion block). Captured: every run-logger line, every `AuditLog` entry and everything
 * written to `console.*`, `process.stdout` and `process.stderr` during all three phases.
 *
 * PII values are drawn from Cyrillic, CJK and Hangul code points only (BMP, one UTF-16 unit
 * each), while every other generated value (ids, titles, addresses, URLs, admin ARN, request ids,
 * timestamps) is printable ASCII. Thus a 3-character window of a PII value can only appear in a
 * log line if PII leaked — the substring check is meaningful and cannot fail by chance.
 *
 * **Validates: Requirements 18.1, 18.2, 18.3, 18.8**
 */

const RUN_ID = 'run-33';
const ADMIN = 'arn:aws:iam::123456789012:user/admin';
const MIN_LEAK = 3;

const listingSchema = buildSchemas(assertValidTaxonomy(DEFAULT_TAXONOMY_CONFIG), {
  defaultLocale: 'de',
  enabled: [{ locale: 'de', label: 'Deutsch' }],
}).listing;
const tourProviders = TourProvidersConfig.parse({ providers: [] });

// ---------------------------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------------------------

/** Code points disjoint from all other (ASCII) generated values. */
const arbPiiChar: fc.Arbitrary<string> = fc
  .oneof(
    fc.integer({ min: 0x0410, max: 0x044f }), // Cyrillic А–я
    fc.integer({ min: 0x4e00, max: 0x9fff }), // CJK Unified Ideographs
    fc.integer({ min: 0xac00, max: 0xd7a3 }), // Hangul syllables
  )
  .map((cp) => String.fromCodePoint(cp));

const arbPiiValue = (bounds: { readonly max: number }) =>
  fc.string({ unit: arbPiiChar, minLength: MIN_LEAK, maxLength: bounds.max });

type Contact = NonNullable<Listing['contact']>;

const arbContact: fc.Arbitrary<Contact> = fc.record(
  {
    name: arbPiiValue(B.contactName),
    phone: arbPiiValue(B.contactPhone),
    email: arbPiiValue(B.contactEmail),
  },
  { requiredKeys: [] },
);

/** Listing (provenance is set by the pipeline) with a PII-only contact or none. */
const arbCandidateListing: fc.Arbitrary<Listing> = fc
  .tuple(arbListing(), fc.option(arbContact, { nil: undefined }))
  .map(([listing, contact]) => {
    const next: Listing = { ...listing };
    delete next.contact;
    return contact === undefined ? next : { ...next, contact };
  });

/** `undefined` = `pii-allowlist.json` missing; otherwise any subset, including the empty one. */
const arbAllowlist: fc.Arbitrary<PiiAllowlistConfig | undefined> = fc.option(
  fc.subarray([...PII_FIELD_PATHS]).map((allowedFields) => ({ allowedFields })),
  { nil: undefined },
);

const arbScenario = fc.record({
  listings: fc.uniqueArray(arbCandidateListing, {
    minLength: 1,
    maxLength: 4,
    selector: (l) => l.id,
  }),
  allowlist: arbAllowlist,
  deleteByIdIndex: fc.nat(),
});

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const contactKey = (path: string): keyof Contact => path.slice('contact.'.length) as keyof Contact;

/** Present PII paths of l that are not allow-listed, in `PII_FIELD_PATHS` order. */
const droppedPaths = (listing: Listing, allowed: ReadonlySet<string>): string[] =>
  PII_FIELD_PATHS.filter(
    (path) => !allowed.has(path) && listing.contact?.[contactKey(path)] !== undefined,
  );

/** What the store must hold: l enriched, tours removed (no providers), dropped PII removed. */
function expectedRecord(listing: Listing, allowed: ReadonlySet<string>): Listing {
  const expected = expectedStored(listing, RUN_ID);
  if (listing.contact === undefined) return expected;
  const dropped = new Set(droppedPaths(listing, allowed).map(contactKey));
  const contact = Object.fromEntries(
    Object.entries(listing.contact).filter(([key]) => !dropped.has(key as keyof Contact)),
  ) as Contact;
  // An object without any remaining field is omitted by the import merge (no Inhaltsfeld).
  return Object.keys(contact).length === 0 ? expected : { ...expected, contact };
}

function toCandidate(listing: Listing): Input {
  return {
    ...toInput(listing),
    ...(listing.contact !== undefined && { contact: { ...listing.contact } }),
  };
}

/** All 3-character windows of all PII values. */
function leakWindows(listings: readonly Listing[]): Set<string> {
  const windows = new Set<string>();
  for (const value of listings.flatMap((l) => Object.values(l.contact ?? {}))) {
    if (value === undefined) continue;
    for (let i = 0; i + MIN_LEAK <= value.length; i += 1) {
      windows.add(value.slice(i, i + MIN_LEAK));
    }
  }
  return windows;
}

/** First PII window found in `text` (one pass over the text), or `undefined`. */
function findLeak(text: string, windows: ReadonlySet<string>): string | undefined {
  for (let i = 0; i + MIN_LEAK <= text.length; i += 1) {
    const window = text.slice(i, i + MIN_LEAK);
    if (windows.has(window)) return window;
  }
  return undefined;
}

/** Captures everything written via `console.*`, `process.stdout` and `process.stderr`. */
function captureOutput(): { readonly lines: string[]; readonly restore: () => void } {
  const lines: string[] = [];
  const spies = [
    ...(['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map((method) =>
      jest.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push(format(...args));
      }),
    ),
    ...[process.stdout, process.stderr].map((stream) =>
      jest.spyOn(stream, 'write').mockImplementation((chunk: unknown) => {
        lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString());
        return true;
      }),
    ),
  ];
  return { lines, restore: () => spies.forEach((spy) => spy.mockRestore()) };
}

function request(body: unknown): AdminRequest {
  return {
    httpMethod: 'POST',
    path: '/admin/deletions',
    body: JSON.stringify(body),
    requestContext: { identity: { userArn: ADMIN } },
  };
}

// ---------------------------------------------------------------------------------------------
// Property
// ---------------------------------------------------------------------------------------------

describe('Property 33: PII-Filter und wertfreies Logging', () => {
  afterEach(() => jest.restoreAllMocks());

  it('drops non-allow-listed PII, logs field/id/source only, and no log or audit entry leaks PII', async () => {
    await fc.assert(
      fc.asyncProperty(arbScenario, async ({ listings, allowlist, deleteByIdIndex }) => {
        const allowed = new Set<string>(allowlist?.allowedFields ?? []);
        const runLines: string[] = [];
        const blocklist = new InMemoryDeletionBlocklist();
        const writer = new InMemoryImportStore({ blocklist, clock: () => NOW.getTime() });
        const pipeline = new ImportPipeline({
          listingSchema,
          reader: writer.reader,
          writer: writer.writer,
          tourProviders,
          ...(allowlist !== undefined && { piiAllowlist: allowlist }),
        });
        const ctx: RecordProcessingContext = {
          runId: RUN_ID,
          source: SOURCE,
          logger: createRunLogger({
            runId: RUN_ID,
            source: SOURCE,
            sink: (line) => runLines.push(line),
            now: () => NOW,
          }),
        };

        const backing = new Map<string, Listing>();
        const harness = createDeletionHarness({
          clock: () => NOW.getTime(),
          listings: backing,
          blocklistMirror: blocklist,
        });
        let requestIds = 0;
        const handler = createAdminHandler({
          apiKeys: new InMemoryApiKeyStore(),
          accessConfig: new StaticAccessConfigSource({
            mode: 'open',
            rateLimit: { requests: 60, windowSeconds: 60 },
          }),
          audit: harness.audit,
          clock: () => NOW.getTime(),
          deletions: { ...harness.deletions, newRequestId: () => `req-${++requestIds}` },
        });

        const output = captureOutput();
        const outcomes: unknown[] = [];
        const reimport: unknown[] = [];
        const statuses: number[] = [];
        try {
          // Import.
          for (const listing of listings) {
            outcomes.push(await pipeline.process(toCandidate(listing), ctx));
          }
          // The deletion store sees the stored records, PII included where allow-listed.
          for (const listing of listings) {
            const record = writer.get(listing.id);
            if (record !== undefined) backing.set(record.id, record);
          }
          // Deletion: one listing by id, the remaining ones by source.
          const byId = listings[deleteByIdIndex % listings.length]?.id ?? '';
          statuses.push((await handler(request({ listingId: byId }))).statusCode);
          if (backing.size > 0) {
            statuses.push((await handler(request({ source: SOURCE }))).statusCode);
          }
          // Re-import after deletion (rejected by the deletion block).
          for (const listing of listings) {
            reimport.push(await pipeline.process(toCandidate(listing), ctx));
          }
        } finally {
          output.restore();
        }

        // Stored record: exactly l without the non-allow-listed PII fields (Req 18.1, 18.3).
        expect(outcomes).toStrictEqual(listings.map(() => 'imported'));
        listings.forEach((listing) => {
          const expected = structuredClone(expectedRecord(listing, allowed));
          expect(writer.get(listing.id)).toStrictEqual(expected);
          PII_FIELD_PATHS.filter((path) => !allowed.has(path)).forEach((path) =>
            expect(writer.get(listing.id)?.contact?.[contactKey(path)]).toBeUndefined(),
          );
        });

        // One drop log per dropped field with field name, listing id and source (Req 18.2).
        const dropLogs = runLines
          .map((line) => JSON.parse(line) as Record<string, unknown>)
          .filter((entry) => entry['event'] === 'pii.field_dropped')
          .map(({ listingId, field, source }) => ({ listingId, field, source }));
        const expectedDrops = listings.flatMap((listing) =>
          droppedPaths(listing, allowed).map((field) => ({
            listingId: listing.id,
            field,
            source: SOURCE,
          })),
        );
        expect(dropLogs).toStrictEqual(expectedDrops);

        // Deletion ran: everything removed and audited.
        expect(statuses.every((status) => status === 202)).toBe(true);
        expect(backing.size).toBe(0);
        expect(harness.audit.entries).toHaveLength(statuses.length);
        expect(reimport).toStrictEqual(listings.map(() => 'rejected'));

        // No log or audit entry contains a PII value or a ≥3-character part of it (18.2, 18.8).
        const windows = leakWindows(listings);
        const written = [
          ...runLines,
          ...output.lines,
          ...harness.audit.entries.map((entry) => JSON.stringify(entry)),
        ];
        written.forEach((text) =>
          expect({ text, leak: findLeak(text, windows) }).toEqual({ text, leak: undefined }),
        );
      }),
      { numRuns: 100 },
    );
  });
});
