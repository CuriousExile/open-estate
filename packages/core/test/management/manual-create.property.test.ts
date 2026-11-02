// Feature: listing-management, Property 8: Manuelle Anlage
import {
  contentRules,
  contentToInput,
  InMemoryAgencyStore,
  InMemoryAuditService,
  InMemoryDeletionBlocklistCheck,
  InMemoryListingKeyStore,
  InMemoryListingVersionStore,
  InMemoryManagedListingStore,
  InMemoryMetricCounterStore,
  InMemorySnapshotStore,
  InMemoryTransactor,
  ListingCommandService,
  manualContentSchema,
  prepareContent,
  VersionedListingWriter,
  type AgencyRecord,
} from '@open-estate/core';
import {
  assertValidTaxonomy,
  buildSchemas,
  DEFAULT_TAXONOMY_CONFIG,
  LISTING_STATUSES,
  PII_FIELD_PATHS,
  publicDetailUrl,
  type ApiError,
  type ListingStatus,
  type Principal,
} from '@open-estate/shared';
import fc from 'fast-check';
import {
  arbAgencyUserPrincipal,
  arbListingContent,
  arbMachinePrincipal,
  arbPermissionSet,
  arbPlatformAdminPrincipal,
} from '../../../shared/test/arbitraries';

/**
 * Property 8: for any valid Listing_Inhalt (for `MANUAL` with or without source URL) and optional
 * status, `create` stores exactly one listing with a new, unique id, the actor's agency, origin
 * `MANUAL`, version 1, the given status or `INACTIVE`, and the delivered source URL or
 * `publicDetailUrl(frontendOrigin, id)`; PII fields outside the allow-list are dropped as in the
 * import and named. For any content the Management_API accepts exactly the contents the import
 * validation accepts; on rejection the store is unchanged and every invalid field is named.
 *
 * Reference of the import validation: `prepareContent` with the import's listing schema
 * (`buildSchemas(taxonomy, locales).listing`) on the candidate completed with the provenance
 * fields, as `ImportPipeline` does.
 *
 * **Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.10**
 */

const RUNS = { numRuns: 100 };
const ORIGIN = 'https://estate.example';
const T0 = Date.parse('2026-03-01T10:00:00.000Z');
const AGENCY_IDS = ['agy-a', 'agy-b', 'agy-c'] as const;

const taxonomy = assertValidTaxonomy(DEFAULT_TAXONOMY_CONFIG);
const importSchema = buildSchemas(taxonomy, {
  defaultLocale: 'de',
  enabled: [{ locale: 'de', label: 'Deutsch' }],
}).listing;

type Obj = Record<string, unknown>;

const isPlainObject = (value: unknown): value is Obj =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const agency = (agencyId: string): AgencyRecord => ({
  agencyId,
  displayName: agencyId,
  state: 'ACTIVE',
  createdAt: '2026-01-01T00:00:00.000Z',
  agencyAdmins: 1,
});

function setup(allowedPii: readonly string[]) {
  let now = T0;
  const listings = new InMemoryManagedListingStore();
  const versions = new InMemoryListingVersionStore();
  const snapshots = new InMemorySnapshotStore();
  const writer = new VersionedListingWriter({
    listings,
    versions,
    keys: new InMemoryListingKeyStore(),
    blocklist: new InMemoryDeletionBlocklistCheck(),
    counters: new InMemoryMetricCounterStore(),
    snapshots,
    transactor: new InMemoryTransactor(),
    clock: () => (now += 1000),
  });
  const rules = contentRules({
    piiAllowlist: { allowedFields: [...allowedPii] },
    tourProviders: { providers: [] },
  });
  // Default id generator (`randomUUID`): uniqueness is part of the property.
  const svc = new ListingCommandService({
    listings,
    versions,
    snapshots,
    agencies: new InMemoryAgencyStore(AGENCY_IDS.map(agency)),
    writer,
    audit: new InMemoryAuditService(),
    frontendOrigin: ORIGIN,
    contentSchema: manualContentSchema(taxonomy),
    rules,
  });
  return { listings, versions, svc, rules };
}

/** Actor with `listing:write` and the agency the listing must belong to. */
interface Creator {
  principal: Principal;
  agencyId: string;
  /** `agencyId` of the request body (Plattform_Admin only). */
  bodyAgency: string | undefined;
}

const arbCreator: fc.Arbitrary<Creator> = fc.oneof(
  arbAgencyUserPrincipal({ agencyIds: AGENCY_IDS }).map((principal): Creator => ({
    principal,
    agencyId: principal.agencyId,
    bodyAgency: undefined,
  })),
  fc
    .tuple(arbMachinePrincipal({ agencyIds: AGENCY_IDS }), arbPermissionSet())
    .map(([principal, extra]): Creator => {
      const permissions = [...new Set([...extra, 'listing:write' as const])];
      return {
        principal: { ...principal, permissions },
        agencyId: principal.agencyId,
        bodyAgency: undefined,
      };
    }),
  fc
    .tuple(arbPlatformAdminPrincipal, fc.constantFrom(...AGENCY_IDS))
    .map(([principal, agencyId]): Creator => ({ principal, agencyId, bodyAgency: agencyId })),
);

const arbAllowedPii = fc.subarray([...PII_FIELD_PATHS]);
const arbStatus = fc.option(fc.constantFrom(...LISTING_STATUSES), { nil: undefined });

/** Valid Listing_Inhalt in the API representation; half of them without source URL. */
const arbInput: fc.Arbitrary<Obj> = fc
  .tuple(arbListingContent(), fc.boolean())
  .map(([content, withSourceUrl]) => {
    const input = structuredClone(contentToInput(content)) as Obj;
    if (!withSourceUrl) delete input['sourceUrl'];
    return input;
  });

const valueAt = (object: Obj, path: string): unknown =>
  path
    .split('.')
    .reduce<unknown>((value, key) => (isPlainObject(value) ? value[key] : undefined), object);

const hasPath = (object: Obj, path: string): boolean => {
  const keys = path.split('.');
  const last = keys.pop() ?? '';
  const parent = keys.reduce<unknown>((v, key) => (isPlainObject(v) ? v[key] : undefined), object);
  return isPlainObject(parent) && Object.hasOwn(parent, last);
};

function deletePath(object: Obj, path: string): void {
  const keys = path.split('.');
  const last = keys.pop() ?? '';
  const parent = keys.reduce<unknown>((v, key) => (isPlainObject(v) ? v[key] : undefined), object);
  if (isPlainObject(parent)) Reflect.deleteProperty(parent, last);
}

function createBody(input: Obj, status: ListingStatus | undefined, creator: Creator): Obj {
  return {
    content: input,
    ...(status !== undefined && { status }),
    ...(creator.bodyAgency !== undefined && { agencyId: creator.bodyAgency }),
  };
}

const fieldsOf = (errors: readonly ApiError[]) =>
  [...new Set(errors.map((e) => e.field ?? ''))].sort();

describe('Property 8: Manuelle Anlage', () => {
  it('creates a MANUAL listing v1 with unique id, actor agency, status and source URL', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbAllowedPii,
        fc.array(fc.tuple(arbCreator, arbInput, arbStatus), { minLength: 1, maxLength: 4 }),
        async (allowedPii, creations) => {
          const s = setup(allowedPii);
          const ids = new Set<string>();

          for (const [creator, input, status] of creations) {
            const before = s.versions.all().length;
            const result = await s.svc.create(
              creator.principal,
              createBody(structuredClone(input), status, creator),
            );
            expect(result.ok).toBe(true);
            if (!result.ok) return;
            const view = result.value;

            // New, unique id; exactly one listing and one version (CREATE, v1) added.
            expect(ids.has(view.id)).toBe(false);
            ids.add(view.id);
            expect(s.listings.all()).toHaveLength(ids.size);
            const added = s.versions.all().slice(before);
            expect(added).toHaveLength(1);
            expect(added[0]).toMatchObject({
              listingId: view.id,
              version: 1,
              changeType: 'CREATE',
            });

            const delivered = input['sourceUrl'];
            const sourceUrl = delivered ?? publicDetailUrl(ORIGIN, view.id);
            expect(view).toMatchObject({
              origin: 'MANUAL',
              version: 1,
              agencyId: creator.agencyId,
              status: status ?? 'INACTIVE',
              sourceUrlDerived: delivered === undefined,
            });

            // PII outside the allow-list and tours of no allowed provider are dropped and named.
            const droppedPii = PII_FIELD_PATHS.filter(
              (path) => !allowedPii.includes(path) && hasPath(input, path),
            );
            const tours = (input['tours'] as unknown[] | undefined) ?? [];
            const dropped = [...droppedPii, ...tours.map((_, i) => `tours.${i}`)];
            expect(view.droppedFields).toEqual(dropped.length > 0 ? dropped : undefined);

            const expected = structuredClone(input);
            for (const path of droppedPii) deletePath(expected, path);
            expect(view.content).toEqual({ ...expected, tours: [], sourceUrl });

            const stored = await s.listings.get(view.id);
            expect(stored?.listing.id).toBe(view.id);
            expect(stored?.listing.sourceUrl).toBe(sourceUrl);
            expect(stored?.management).toMatchObject({
              origin: 'MANUAL',
              version: 1,
              agencyId: creator.agencyId,
              status: status ?? 'INACTIVE',
            });
            for (const path of droppedPii) {
              expect(valueAt(stored?.listing as unknown as Obj, path)).toBeUndefined();
            }
          }
        },
      ),
      RUNS,
    );
  });

  /** Edits of a valid input; some are invalid, some are healed by PII filter or cleanup. */
  const set =
    (key: string, value: unknown) =>
    (input: Obj): void => {
      if (value === undefined) Reflect.deleteProperty(input, key);
      else input[key] = value;
    };
  const setNested =
    (parent: string, key: string, value: unknown) =>
    (input: Obj): void => {
      const current = input[parent];
      input[parent] = { ...(isPlainObject(current) ? current : {}), [key]: value };
    };
  const EDITS: readonly { name: string; apply: (input: Obj) => void }[] = [
    { name: 'title empty', apply: set('title', '') },
    { name: 'title removed', apply: set('title', undefined) },
    { name: 'listingType unknown', apply: set('listingType', 'castle') },
    { name: 'sourceUrl ftp', apply: set('sourceUrl', 'ftp://files.example/x') },
    { name: 'rooms 2.3', apply: set('rooms', 2.3) },
    { name: 'area too small', apply: set('area', '0.99') },
    { name: 'area not a number', apply: set('area', 'x') },
    { name: 'originalLocale removed', apply: set('originalLocale', undefined) },
    { name: 'address removed', apply: set('address', undefined) },
    { name: 'address.country DEU', apply: setNested('address', 'country', 'DEU') },
    { name: 'geo.lat 90.5', apply: setNested('geo', 'lat', 90.5) },
    { name: 'no offers', apply: set('offers', []) },
    { name: 'offers not a list', apply: set('offers', 'SALE') },
    // Healed by the PII filter unless `contact.email` is allow-listed (Req 4.10).
    { name: 'contact.email not a string', apply: setNested('contact', 'email', 42) },
    // Healed by the media cleanup (dropped medium).
    { name: 'invalid medium', apply: set('media', [{ url: 'not a url' }]) },
    { name: 'unknown field', apply: set('unknownField', true) },
  ];

  it('accepts exactly what the import validation accepts; rejections name every field', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbAllowedPii,
        arbCreator,
        arbInput,
        arbStatus,
        fc.subarray([...EDITS], { maxLength: 3 }),
        async (allowedPii, creator, valid, status, edits) => {
          const s = setup(allowedPii);
          // A previously created listing: the store is not empty when a rejection happens.
          const seeded = await s.svc.create(
            creator.principal,
            createBody(structuredClone(valid), status, creator),
          );
          expect(seeded.ok).toBe(true);

          const input = structuredClone(valid);
          for (const edit of edits) edit.apply(input);
          const listingsBefore = s.listings.all();
          const versionsBefore = s.versions.all();

          const result = await s.svc.create(
            creator.principal,
            createBody(structuredClone(input), status, creator),
          );

          // The id only enters the derived source URL, which is valid for any id.
          const id = result.ok ? result.value.id : 'lst-reference';
          const reference = prepareContent(
            {
              ...input,
              ...(input['sourceUrl'] === undefined && { sourceUrl: publicDetailUrl(ORIGIN, id) }),
              id,
              source: `agency:${creator.agencyId}`,
              lastImportedAt: new Date(T0).toISOString(),
              lastRunId: 'PORTAL#1',
            },
            importSchema,
            s.rules,
          );

          expect(result.ok).toBe(reference.ok);
          if (result.ok || reference.ok) return;
          expect(result.error.every((e) => e.code === 'INVALID_PARAMETER')).toBe(true);
          const expectedFields = [
            ...new Set(
              reference.issues.map((issue) =>
                issue.field === 'record' ? 'content' : `content.${issue.field}`,
              ),
            ),
          ].sort();
          expect(fieldsOf(result.error)).toEqual(expectedFields);
          expect(s.listings.all()).toEqual(listingsBefore);
          expect(s.versions.all()).toEqual(versionsBefore);
        },
      ),
      RUNS,
    );
  });
});
