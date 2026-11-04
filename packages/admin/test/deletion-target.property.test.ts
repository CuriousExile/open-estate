// Feature: real-estate-platform, Property 34: Löschung entfernt genau die Zielmenge
import fc from 'fast-check';
import { createAdminHandler, InMemoryAuditLog, type AdminRequest } from '@open-estate/admin';
import { InMemoryApiKeyStore, StaticAccessConfigSource } from '@open-estate/core';
import type { ApiError } from '@open-estate/shared';
import { createDeletionHarness } from './support/deletion-harness';

/** **Validates: Requirements 18.4, 18.9** */

const RUNS = { numRuns: 100 };
const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
const ADMIN = 'arn:aws:iam::123456789012:user/admin';

// Small pools, so source criteria match several listings and missing criteria stay plausible.
const ID_POOL = Array.from({ length: 12 }, (_, i) => `L-${String(i).padStart(2, '0')}`);
const SOURCE_POOL = ['partner-a', 'partner-b', 'partner-c', 'partner-d'];

interface StoredListing {
  id: string;
  source: string;
  title: string;
  contact: { name: string; email: string };
}

type Criterion = { listingId: string } | { source: string };

// --- Arbitraries ------------------------------------------------------------------------------

const arbListing: fc.Arbitrary<StoredListing> = fc.record({
  id: fc.constantFrom(...ID_POOL),
  source: fc.constantFrom(...SOURCE_POOL),
  title: fc.string({ maxLength: 20 }),
  contact: fc.record({ name: fc.string({ maxLength: 10 }), email: fc.emailAddress() }),
});

const arbStore = fc.uniqueArray(arbListing, { selector: (listing) => listing.id, maxLength: 10 });

/** Store state plus a criterion that matches at least one listing. */
const arbMatchingCase = arbStore
  .filter((listings) => listings.length > 0)
  .chain((listings) =>
    fc.record({
      listings: fc.constant(listings),
      pageSize: fc.integer({ min: 1, max: 4 }),
      criterion: fc.oneof(
        fc.constantFrom(...listings.map((l) => l.id)).map((listingId) => ({ listingId })),
        fc.constantFrom(...listings.map((l) => l.source)).map((source) => ({ source })),
      ) as fc.Arbitrary<Criterion>,
    }),
  );

/** Store state plus a criterion (id or source) that matches no listing. */
const arbMissingCase = arbStore.chain((listings) => {
  const ids = new Set(listings.map((l) => l.id));
  const sources = new Set(listings.map((l) => l.source));
  const missingIds = [...ID_POOL.filter((id) => !ids.has(id)), 'L-missing'];
  const missingSources = [...SOURCE_POOL.filter((s) => !sources.has(s)), 'unknown-source'];
  return fc.record({
    listings: fc.constant(listings),
    pageSize: fc.integer({ min: 1, max: 4 }),
    criterion: fc.oneof(
      fc.constantFrom(...missingIds).map((listingId) => ({ listingId })),
      fc.constantFrom(...missingSources).map((source) => ({ source })),
    ) as fc.Arbitrary<Criterion>,
  });
});

// --- Helpers ----------------------------------------------------------------------------------

function setup(listings: StoredListing[], pageSize: number) {
  const clock = () => T0;
  const audit = new InMemoryAuditLog();
  const backing = new Map(listings.map((listing) => [listing.id, structuredClone(listing)]));
  const harness = createDeletionHarness({ clock, audit, listings: backing, pageSize });
  let ids = 0;
  const handler = createAdminHandler({
    apiKeys: new InMemoryApiKeyStore(),
    accessConfig: new StaticAccessConfigSource({
      mode: 'open',
      rateLimit: { requests: 60, windowSeconds: 60 },
    }),
    audit,
    clock,
    deletions: { ...harness.deletions, newRequestId: () => `req-${++ids}` },
  });
  return { ...harness, handler, backing };
}

const post = (body: Criterion): AdminRequest => ({
  httpMethod: 'POST',
  path: '/admin/deletions',
  body: JSON.stringify(body),
  requestContext: { identity: { userArn: ADMIN } },
});

const matches = (listing: StoredListing, criterion: Criterion) =>
  'listingId' in criterion
    ? listing.id === criterion.listingId
    : listing.source === criterion.source;

const sorted = (values: string[]) => [...values].sort();

// --- Properties -------------------------------------------------------------------------------

describe('Property 34: Löschung entfernt genau die Zielmenge', () => {
  it('executed request removes exactly the matching listings and leaves all others unchanged', async () => {
    await fc.assert(
      fc.asyncProperty(arbMatchingCase, async ({ listings, pageSize, criterion }) => {
        const { handler, backing, blocklist, requests } = setup(listings, pageSize);
        const targets = listings.filter((listing) => matches(listing, criterion));
        const others = listings.filter((listing) => !matches(listing, criterion));

        const res = await handler(post(criterion));

        expect(res.statusCode).toBe(202);
        expect(await requests.get('req-1')).toMatchObject({
          criterion,
          status: 'EXECUTED',
          removedCount: targets.length,
        });
        expect(sorted([...backing.keys()])).toEqual(sorted(others.map((l) => l.id)));
        for (const listing of others) expect(backing.get(listing.id)).toEqual(listing);
        expect(sorted(blocklist.ids())).toEqual(sorted(targets.map((l) => l.id)));
        for (const listing of targets) {
          expect(blocklist.get(listing.id)).toMatchObject({
            listingId: listing.id,
            source: listing.source,
            requestId: 'req-1',
          });
        }
      }),
      RUNS,
    );
  });

  it('criterion without match is rejected naming the criterion; store stays unchanged', async () => {
    await fc.assert(
      fc.asyncProperty(arbMissingCase, async ({ listings, pageSize, criterion }) => {
        const { handler, backing, blocklist, requests, audit } = setup(listings, pageSize);
        const field = Object.keys(criterion)[0];

        const res = await handler(post(criterion));

        expect(res.statusCode).toBe(404);
        const { errors } = JSON.parse(res.body) as { errors: ApiError[] };
        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatchObject({
          code: 'DELETION_TARGET_NOT_FOUND',
          field,
          details: { criterion },
        });
        expect(errors[0]?.message).toContain(Object.values(criterion)[0] as string);
        expect(sorted([...backing.keys()])).toEqual(sorted(listings.map((l) => l.id)));
        for (const listing of listings) expect(backing.get(listing.id)).toEqual(listing);
        expect(blocklist.ids()).toEqual([]);
        expect(requests.all()).toEqual([]);
        expect(audit.entries).toEqual([]);
      }),
      RUNS,
    );
  });
});
