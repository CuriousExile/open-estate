import fc from 'fast-check';
// Package import (not '../../src'), see ./listing.
import {
  AGENCY_ROLES,
  AGENCY_STATES,
  CHANNELS,
  CONTENT_FIELDS,
  IMPORT_MODES,
  LISTING_STATUSES,
  MANAGEMENT_BOUNDS as M,
  ORIGINS,
  PERMISSIONS,
  type ActorRef,
  type AgencyState,
  type Channel,
  type ContentPath,
  type DeepPartialNullable,
  type FieldSource,
  type FieldSources,
  type ImportMode,
  type ImportRecord,
  type Listing,
  type ListingContent,
  type ListingStatus,
  type Origin,
  type Permission,
  type Principal,
  type VersionedState,
} from '@open-estate/shared';
import { arbIsoDateTime, arbListing, type ListingArbOptions } from './listing';

// Generators for the listing management (design: "Testing Strategy"): principals, agencies,
// versioned listings, Import_Datensätze, operation sequences and a simulated clock. They only
// build on the types and schemas of `management.ts`, `content.ts` and `schema/management.ts`.

type Bounds = { readonly min: number; readonly max: number };

const boundedString = (bounds: Bounds): fc.Arbitrary<string> =>
  fc.string({ minLength: bounds.min, maxLength: bounds.max });

/** Picks from `pool` if given and non-empty, otherwise uses `fallback`. */
const fromPool = <T>(pool: readonly T[] | undefined, fallback: fc.Arbitrary<T>): fc.Arbitrary<T> =>
  pool !== undefined && pool.length > 0 ? fc.constantFrom(...pool) : fallback;

// ---------------------------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------------------------

/** Readable identifiers with disjoint prefixes, so ids of different kinds never collide. */
const prefixedId = (prefix: string): fc.Arbitrary<string> =>
  fc.stringMatching(/^[a-z0-9]{1,12}$/).map((suffix) => `${prefix}-${suffix}`);

export const arbAgencyId = prefixedId('agy');
export const arbUserId = prefixedId('usr');
export const arbKeyId = prefixedId('mk');
export const arbListingId = prefixedId('lst');
export const arbConnectorId = prefixedId('conn');
export const arbRunId = prefixedId('run');

/** Custom_Id: any string of 1–128 characters (Req 4.11). */
export const arbCustomId: fc.Arbitrary<string> = boundedString(M.customId);

const arbDisplayName = boundedString(M.displayName);

// ---------------------------------------------------------------------------------------------
// Principals and actors
// ---------------------------------------------------------------------------------------------

/** Random permission set: any subset of `pool` (default: all permissions), possibly empty. */
export function arbPermissionSet(
  pool: readonly Permission[] = PERMISSIONS,
): fc.Arbitrary<Permission[]> {
  return fc.subarray([...pool]);
}

export interface PrincipalArbOptions {
  /** Agencies to choose from (default: random agency ids). */
  agencyIds?: readonly string[];
  /** Permission pool of machine accesses (default: all permissions, also non-grantable ones). */
  permissions?: readonly Permission[];
}

export type AgencyUserPrincipal = Extract<Principal, { agencyId: string; kind: 'user' }>;
export type PlatformAdminPrincipal = Extract<Principal, { role: 'PLATFORM_ADMIN' }>;
export type MachinePrincipal = Extract<Principal, { kind: 'machine' }>;

/** Agentur_Mitglied or Agentur_Admin of one agency. */
export function arbAgencyUserPrincipal(
  options: PrincipalArbOptions = {},
): fc.Arbitrary<AgencyUserPrincipal> {
  return fc.record({
    kind: fc.constant('user' as const),
    userId: arbUserId,
    displayName: arbDisplayName,
    role: fc.constantFrom(...AGENCY_ROLES),
    agencyId: fromPool(options.agencyIds, arbAgencyId),
  });
}

export const arbPlatformAdminPrincipal: fc.Arbitrary<PlatformAdminPrincipal> = fc.record({
  kind: fc.constant('user' as const),
  userId: arbUserId,
  displayName: arbDisplayName,
  role: fc.constant('PLATFORM_ADMIN' as const),
});

/** Maschinenzugang of one agency with a random permission set. */
export function arbMachinePrincipal(
  options: PrincipalArbOptions = {},
): fc.Arbitrary<MachinePrincipal> {
  return fc.record({
    kind: fc.constant('machine' as const),
    keyId: arbKeyId,
    label: boundedString(M.machineAccessLabel),
    agencyId: fromPool(options.agencyIds, arbAgencyId),
    permissions: arbPermissionSet(options.permissions),
  });
}

/** Principals of all roles and machine accesses. */
export function arbPrincipal(options: PrincipalArbOptions = {}): fc.Arbitrary<Principal> {
  return fc.oneof(
    arbAgencyUserPrincipal(options),
    arbPlatformAdminPrincipal,
    arbMachinePrincipal(options),
  );
}

/** Actor matching the change channel: IMPORT → connector, API → machine, PORTAL → user, ADMIN → user or IAM. */
export function arbActorRef(channel?: Channel): fc.Arbitrary<ActorRef> {
  const user = fc.record({
    kind: fc.constant('user' as const),
    userId: arbUserId,
    displayName: arbDisplayName,
  });
  const machine = fc.record({
    kind: fc.constant('machine' as const),
    keyId: arbKeyId,
    label: boundedString(M.machineAccessLabel),
  });
  const connector = fc.record({
    kind: fc.constant('connector' as const),
    connectorId: arbConnectorId,
    runId: arbRunId,
  });
  const iam = fc.record({
    kind: fc.constant('iam' as const),
    userArn: fc
      .stringMatching(/^[A-Za-z0-9+=,.@_-]{1,32}$/)
      .map((name) => `arn:aws:iam::123456789012:user/${name}`),
  });
  switch (channel) {
    case 'IMPORT':
      return connector;
    case 'API':
      return machine;
    case 'PORTAL':
      return user;
    case 'ADMIN':
      return fc.oneof(user, iam);
    case undefined:
      return fc.oneof(user, machine, connector, iam);
  }
}

// ---------------------------------------------------------------------------------------------
// Agencies
// ---------------------------------------------------------------------------------------------

/** Agency as stored (`Agencies` table) and returned (`AgencyView`). */
export interface AgencyRecord {
  agencyId: string;
  displayName: string;
  state: AgencyState;
  createdAt: string;
}

export function arbAgency(
  states: readonly AgencyState[] = AGENCY_STATES,
): fc.Arbitrary<AgencyRecord> {
  return fc.record({
    agencyId: arbAgencyId,
    displayName: boundedString(M.agencyName),
    state: fc.constantFrom(...states),
    createdAt: arbIsoDateTime,
  });
}

/** Agencies with pairwise distinct ids. */
export function arbAgencies(
  constraints: { minLength?: number; maxLength?: number; states?: readonly AgencyState[] } = {},
): fc.Arbitrary<AgencyRecord[]> {
  return fc.uniqueArray(arbAgency(constraints.states), {
    selector: (a) => a.agencyId,
    minLength: constraints.minLength ?? 1,
    maxLength: constraints.maxLength ?? 5,
  });
}

// ---------------------------------------------------------------------------------------------
// Listing content and versioned listings
// ---------------------------------------------------------------------------------------------

/** Listing_Inhalt of a listing: all CONTENT_FIELDS that are present. */
export function toContent(listing: Listing): ListingContent {
  return Object.fromEntries(
    CONTENT_FIELDS.filter((field) => listing[field] !== undefined).map((field) => [
      field,
      listing[field],
    ]),
  ) as ListingContent;
}

/** Valid Listing_Inhalt in the internal representation (minor units). */
export function arbListingContent(options: ListingArbOptions = {}): fc.Arbitrary<ListingContent> {
  return arbListing(options).map(toContent);
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Inhaltsfelder of a content, sorted: objects resolved recursively, lists and scalars are leaves.
 * Test-local reference of the design rule (keys of the Feldherkunft), independent of
 * `contentPaths` in `content.ts`.
 */
export function referenceContentPaths(content: ListingContent): ContentPath[] {
  const paths: ContentPath[] = [];
  const walk = (value: unknown, path: string): void => {
    if (value === undefined) return;
    if (isPlainObject(value)) {
      for (const [key, child] of Object.entries(value)) walk(child, `${path}.${key}`);
    } else {
      paths.push(path);
    }
  };
  for (const field of CONTENT_FIELDS) walk(content[field], field);
  return paths.sort();
}

export function arbFieldSource(
  maxVersion: number,
  channels: readonly Channel[] = CHANNELS,
): fc.Arbitrary<FieldSource> {
  return fc.constantFrom(...channels).chain((channel) =>
    fc.record({
      channel: fc.constant(channel),
      actor: arbActorRef(channel),
      version: fc.integer({ min: 1, max: maxVersion }),
    }),
  );
}

/** Feldherkunft for exactly the Inhaltsfelder of `content`, versions 1..`version`. */
export function arbFieldSources(
  content: ListingContent,
  version: number,
): fc.Arbitrary<FieldSources> {
  const paths = referenceContentPaths(content);
  return fc
    .tuple(...paths.map(() => arbFieldSource(version)))
    .map(
      (sources) => Object.fromEntries(paths.map((path, i) => [path, sources[i]])) as FieldSources,
    );
}

export interface VersionedStateArbOptions {
  /** Agencies to choose from (default: random agency ids). */
  agencyIds?: readonly string[];
  /** Whether listings without agency (connector without agency assignment) occur; default true. */
  agencyless?: boolean;
  statuses?: readonly ListingStatus[];
  content?: ListingArbOptions;
}

/** Versioned state: content, status, optional Custom_Id and optional owning agency. */
export function arbVersionedState(
  options: VersionedStateArbOptions = {},
): fc.Arbitrary<VersionedState> {
  const requiredKeys: ('content' | 'status' | 'agencyId')[] =
    options.agencyless === false ? ['content', 'status', 'agencyId'] : ['content', 'status'];
  return fc.record(
    {
      content: arbListingContent(options.content),
      status: fc.constantFrom(...(options.statuses ?? LISTING_STATUSES)),
      customId: arbCustomId,
      agencyId: fromPool(options.agencyIds, arbAgencyId),
    },
    { requiredKeys },
  );
}

/** Listing as managed by the platform (management data of the `Listings` table). */
export interface ManagedListing {
  id: string;
  origin: Origin;
  /** Current Versionsnummer, ≥ 1. */
  version: number;
  state: VersionedState;
  /** Keys = Inhaltsfelder of `state.content`. */
  fieldSources: FieldSources;
  updatedAt: string;
}

export interface ManagedListingArbOptions extends VersionedStateArbOptions {
  origins?: readonly Origin[];
  maxVersion?: number;
}

export function arbManagedListing(
  options: ManagedListingArbOptions = {},
): fc.Arbitrary<ManagedListing> {
  return fc
    .record({
      id: arbListingId,
      origin: fc.constantFrom(...(options.origins ?? ORIGINS)),
      version: fc.integer({ min: 1, max: options.maxVersion ?? 50 }),
      state: arbVersionedState(options),
      updatedAt: arbIsoDateTime,
    })
    .chain((listing) =>
      arbFieldSources(listing.state.content, listing.version).map(
        (fieldSources): ManagedListing => ({ ...listing, fieldSources }),
      ),
    );
}

const withoutCustomId = (state: VersionedState): VersionedState => {
  const rest = { ...state };
  delete rest.customId;
  return rest;
};

/**
 * Listings with pairwise distinct ids and Custom_Ids unique per agency (later duplicates lose
 * their Custom_Id), like the `ListingKeys` invariant.
 */
export function arbListingInventory(
  options: ManagedListingArbOptions & { minLength?: number; maxLength?: number } = {},
): fc.Arbitrary<ManagedListing[]> {
  return fc
    .uniqueArray(arbManagedListing(options), {
      selector: (l) => l.id,
      minLength: options.minLength ?? 0,
      maxLength: options.maxLength ?? 8,
    })
    .map((listings) => {
      const keys = new Set<string>();
      return listings.map((listing) => {
        const { customId, agencyId } = listing.state;
        if (customId === undefined) return listing;
        const key = `${agencyId ?? ''}#${customId}`;
        if (!keys.has(key)) {
          keys.add(key);
          return listing;
        }
        return { ...listing, state: withoutCustomId(listing.state) };
      });
    });
}

/** Agencies plus a listing inventory whose listings belong to them (or to no agency). */
export interface AgencyInventory {
  agencies: AgencyRecord[];
  listings: ManagedListing[];
}

export function arbAgencyInventory(
  options: Omit<ManagedListingArbOptions, 'agencyIds'> & {
    maxAgencies?: number;
    maxListings?: number;
  } = {},
): fc.Arbitrary<AgencyInventory> {
  return arbAgencies({ maxLength: options.maxAgencies ?? 4 }).chain((agencies) =>
    arbListingInventory({
      ...options,
      agencyIds: agencies.map((a) => a.agencyId),
      maxLength: options.maxListings ?? 8,
    }).map((listings) => ({ agencies, listings })),
  );
}

// ---------------------------------------------------------------------------------------------
// Import_Datensätze
// ---------------------------------------------------------------------------------------------

/** Optional Inhaltsfelder on every level (Req 12.6: may be removed with `null`). */
export const OPTIONAL_CONTENT_PATHS: ReadonlySet<string> = new Set([
  'geo',
  'contact',
  'address.street',
  'contact.name',
  'contact.phone',
  'contact.email',
  // Objektmerkmale (duplicate-detection Req 1.1), all optional on their level.
  'address.houseNumber',
  'address.unit',
  'floor',
  'totalFloors',
  'yearBuilt',
  'plotArea',
  'bedrooms',
  'bathrooms',
  'parcelId',
]);

/** Keys of the nested content objects (resolved field by field on merge). */
const NESTED_KEYS: Readonly<Record<string, readonly string[]>> = {
  address: ['city', 'postalCode', 'country', 'street', 'houseNumber', 'unit'],
  geo: ['lat', 'lon'],
  contact: ['name', 'phone', 'email'],
};

/** Where `null` may occur: optional fields only (default), every field, or nowhere. */
export type NullMode = 'optional' | 'any' | 'none';

const OMIT = Symbol('omit');

function arbDeepSubset(
  value: Record<string, unknown>,
  keys: readonly string[],
  prefix: string,
  nulls: NullMode,
): fc.Arbitrary<Record<string, unknown>> {
  const entry = (key: string): fc.Arbitrary<unknown> => {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    const child = value[key];
    const nested = NESTED_KEYS[path];
    const options: fc.Arbitrary<unknown>[] = [fc.constant(OMIT)];
    if (child !== undefined) {
      options.push(
        nested !== undefined && isPlainObject(child)
          ? arbDeepSubset(child, nested, path, nulls)
          : fc.constant(child),
      );
    }
    if (nulls === 'any' || (nulls === 'optional' && OPTIONAL_CONTENT_PATHS.has(path))) {
      options.push(fc.constant(null));
    }
    return fc.oneof(...options);
  };
  return fc
    .tuple(...keys.map(entry))
    .map((entries) =>
      Object.fromEntries(
        keys.flatMap((key, i) => (entries[i] === OMIT ? [] : [[key, entries[i]]])),
      ),
    );
}

/**
 * Deep subset of a valid Listing_Inhalt: every field omitted, delivered (nested objects as deep
 * subsets, lists whole) or `null` according to `nulls`.
 */
export function arbImportContent(
  options: { nulls?: NullMode; content?: ListingArbOptions } = {},
): fc.Arbitrary<DeepPartialNullable<ListingContent>> {
  return arbListingContent(options.content).chain(
    (content) =>
      arbDeepSubset(content, CONTENT_FIELDS, '', options.nulls ?? 'optional') as fc.Arbitrary<
        DeepPartialNullable<ListingContent>
      >,
  );
}

/** Identity combinations of an Import_Datensatz (Req 12.2–12.4). */
export const IMPORT_IDENTITY_KINDS = ['none', 'id', 'customId', 'both', 'conflicting'] as const;
export type ImportIdentityKind = (typeof IMPORT_IDENTITY_KINDS)[number];

export interface ImportIdentity {
  kind: ImportIdentityKind;
  id?: string;
  customId?: string;
}

/**
 * Identity of an Import_Datensatz against an inventory, for a connector of `agencyId` (absent =
 * connector without agency). `id`/`customId` refer to existing or fresh listings; `both` is
 * consistent (same listing or at least one fresh), `conflicting` names two different existing
 * listings (only offered if the inventory allows it).
 */
export function arbImportIdentity(
  listings: readonly ManagedListing[],
  agencyId: string | undefined,
  kinds: readonly ImportIdentityKind[] = IMPORT_IDENTITY_KINDS,
): fc.Arbitrary<ImportIdentity> {
  const takenIds = new Set(listings.map((l) => l.id));
  const withCustomId = listings.filter(
    (l): l is ManagedListing & { state: { customId: string } } =>
      l.state.agencyId === agencyId && l.state.customId !== undefined,
  );
  const takenCustomIds = new Set(withCustomId.map((l) => l.state.customId));
  const freshId = arbListingId.filter((id) => !takenIds.has(id));
  const freshCustomId = arbCustomId.filter((c) => !takenCustomIds.has(c));
  const anyId = fromPool(
    listings.map((l) => l.id),
    freshId,
  ).chain((id) => fc.oneof(fc.constant(id), freshId));
  const anyCustomId = fromPool(
    withCustomId.map((l) => l.state.customId),
    freshCustomId,
  ).chain((c) => fc.oneof(fc.constant(c), freshCustomId));

  const conflictPairs = withCustomId.flatMap((b) =>
    listings.filter((a) => a.id !== b.id).map((a) => ({ id: a.id, customId: b.state.customId })),
  );
  const byKind: Record<ImportIdentityKind, fc.Arbitrary<ImportIdentity> | undefined> = {
    none: fc.constant({ kind: 'none' }),
    id: anyId.map((id) => ({ kind: 'id', id })),
    customId: anyCustomId.map((customId) => ({ kind: 'customId', customId })),
    both: fc
      .oneof(
        ...[
          ...(withCustomId.length > 0
            ? [fc.constantFrom(...withCustomId).map((l) => [l.id, l.state.customId] as const)]
            : []),
          fc.tuple(freshId, anyCustomId),
          fc.tuple(anyId, freshCustomId),
        ],
      )
      .map(([id, customId]) => ({ kind: 'both', id, customId })),
    conflicting:
      conflictPairs.length > 0
        ? fc.constantFrom(...conflictPairs).map((pair) => ({ kind: 'conflicting', ...pair }))
        : undefined,
  };
  const available = kinds.flatMap((kind) => {
    const arb = byKind[kind];
    return arb === undefined ? [] : [arb];
  });
  if (available.length === 0) {
    throw new Error(`No import identity of kinds ${kinds.join(', ')} possible for this inventory`);
  }
  return fc.oneof(...available);
}

export interface ImportRecordArbOptions {
  /** Inventory the identity refers to (default: empty, i.e. only fresh identifiers). */
  listings?: readonly ManagedListing[];
  /** Agency of the connector; absent = connector without agency. */
  agencyId?: string;
  kinds?: readonly ImportIdentityKind[];
  nulls?: NullMode;
  content?: ListingArbOptions;
}

/** Import_Datensatz with identity combination, optional status and a deep content subset. */
export function arbImportRecord(
  options: ImportRecordArbOptions = {},
): fc.Arbitrary<{ identity: ImportIdentity; record: ImportRecord }> {
  return fc
    .record(
      {
        identity: arbImportIdentity(options.listings ?? [], options.agencyId, options.kinds),
        status: fc.constantFrom(...LISTING_STATUSES),
        content: arbImportContent(options),
      },
      { requiredKeys: ['identity', 'content'] },
    )
    .map(({ identity, status, content }) => ({
      identity,
      record: {
        ...content,
        ...(identity.id !== undefined && { id: identity.id }),
        ...(identity.customId !== undefined && { customId: identity.customId }),
        ...(status !== undefined && { status }),
      },
    }));
}

// ---------------------------------------------------------------------------------------------
// Operation sequences
// ---------------------------------------------------------------------------------------------

/**
 * One step of an operation sequence. Listing ids and Custom_Ids come from small pools, so
 * sequences hit existing, missing and colliding listings; the consumer applies each step to its
 * model and fakes (unknown targets or missing permissions are expected rejections).
 * `advanceMs` advances the simulated clock before the step.
 */
export type ManagementOperation = { advanceMs: number } & (
  | {
      kind: 'create';
      principal: Principal;
      listingId: string;
      content: ListingContent;
      status?: ListingStatus;
      customId?: string;
      agencyId?: string;
    }
  | {
      kind: 'update';
      principal: Principal;
      listingId: string;
      content: ListingContent;
      customId?: string;
    }
  | { kind: 'status'; principal: Principal; listingId: string; status: ListingStatus }
  | { kind: 'assignAgency'; principal: Principal; listingId: string; agencyId: string }
  | { kind: 'restore'; principal: Principal; listingId: string; version: number }
  | {
      kind: 'import';
      connectorId: string;
      runId: string;
      agencyId?: string;
      mode: ImportMode;
      record: ImportRecord;
    }
  | { kind: 'delete'; listingId: string }
);

export type ManagementOperationKind = ManagementOperation['kind'];

export const MANAGEMENT_OPERATION_KINDS: readonly ManagementOperationKind[] = [
  'create',
  'update',
  'status',
  'assignAgency',
  'restore',
  'import',
  'delete',
];

export interface OperationArbOptions {
  agencyIds?: readonly string[];
  listingIds?: readonly string[];
  customIds?: readonly string[];
  connectorIds?: readonly string[];
  kinds?: readonly ManagementOperationKind[];
  /** Maximum clock advance per step in ms (default: one day). */
  maxAdvanceMs?: number;
  /** Highest restore target version (default 10). */
  maxVersion?: number;
  content?: ListingArbOptions;
}

const DAY_MS = 86_400_000;

export function arbOperation(options: OperationArbOptions = {}): fc.Arbitrary<ManagementOperation> {
  const agencyIds = options.agencyIds ?? ['agy-a', 'agy-b'];
  const listingId = fc.constantFrom(
    ...(options.listingIds ?? ['lst-1', 'lst-2', 'lst-3', 'lst-4']),
  );
  const customId = fc.constantFrom(...(options.customIds ?? ['C-1', 'C-2', 'C-3']));
  const agencyId = fc.constantFrom(...agencyIds);
  const principal = arbPrincipal({ agencyIds });
  const content = arbListingContent(options.content);
  const status = fc.constantFrom(...LISTING_STATUSES);

  const byKind: Record<
    ManagementOperationKind,
    fc.Arbitrary<Omit<ManagementOperation, 'advanceMs'>>
  > = {
    create: fc.record(
      {
        kind: fc.constant('create' as const),
        principal,
        listingId,
        content,
        status,
        customId,
        agencyId,
      },
      { requiredKeys: ['kind', 'principal', 'listingId', 'content'] },
    ),
    update: fc.record(
      { kind: fc.constant('update' as const), principal, listingId, content, customId },
      { requiredKeys: ['kind', 'principal', 'listingId', 'content'] },
    ),
    status: fc.record({ kind: fc.constant('status' as const), principal, listingId, status }),
    assignAgency: fc.record({
      kind: fc.constant('assignAgency' as const),
      principal,
      listingId,
      agencyId,
    }),
    restore: fc.record({
      kind: fc.constant('restore' as const),
      principal,
      listingId,
      version: fc.integer({ min: 1, max: options.maxVersion ?? 10 }),
    }),
    import: fc
      .record(
        {
          connectorId: fc.constantFrom(...(options.connectorIds ?? ['conn-a', 'conn-b'])),
          runId: arbRunId,
          agencyId,
          mode: fc.constantFrom(...IMPORT_MODES),
          id: listingId,
          customId,
          status,
          content: arbImportContent({ ...(options.content && { content: options.content }) }),
        },
        { requiredKeys: ['connectorId', 'runId', 'mode', 'content'] },
      )
      .map(
        ({
          connectorId,
          runId,
          agencyId: connectorAgency,
          mode,
          id,
          customId: cid,
          status: s,
          content: c,
        }) => ({
          kind: 'import' as const,
          connectorId,
          runId,
          ...(connectorAgency !== undefined && { agencyId: connectorAgency }),
          mode,
          record: {
            ...c,
            ...(id !== undefined && { id }),
            ...(cid !== undefined && { customId: cid }),
            ...(s !== undefined && { status: s }),
          },
        }),
      ),
    delete: fc.record({ kind: fc.constant('delete' as const), listingId }),
  };

  return fc
    .tuple(
      fc.oneof(...(options.kinds ?? MANAGEMENT_OPERATION_KINDS).map((kind) => byKind[kind])),
      fc.integer({ min: 0, max: options.maxAdvanceMs ?? DAY_MS }),
    )
    .map(([operation, advanceMs]) => ({ ...operation, advanceMs }) as ManagementOperation);
}

export function arbOperations(
  options: OperationArbOptions & { minLength?: number; maxLength?: number } = {},
): fc.Arbitrary<ManagementOperation[]> {
  return fc.array(arbOperation(options), {
    minLength: options.minLength ?? 1,
    maxLength: options.maxLength ?? 20,
  });
}

// ---------------------------------------------------------------------------------------------
// Simulated clock
// ---------------------------------------------------------------------------------------------

/** Deterministic clock in epoch milliseconds; only moves forward. */
export class SimulatedClock {
  private current: number;

  constructor(startMs: number = Date.parse('2025-01-01T00:00:00.000Z')) {
    this.current = startMs;
  }

  now(): number {
    return this.current;
  }

  /** ISO-8601 timestamp with offset (`Z`), as stored in versions and audit entries. */
  nowIso(): string {
    return new Date(this.current).toISOString();
  }

  advance(ms: number): number {
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError(`Cannot advance clock by ${ms} ms`);
    this.current += ms;
    return this.current;
  }
}

/** Start instant of a simulated clock (2000–2099, epoch ms). */
export const arbClockStart: fc.Arbitrary<number> = fc.integer({
  min: Date.parse('2000-01-01T00:00:00.000Z'),
  max: Date.parse('2099-01-01T00:00:00.000Z'),
});

/** Fresh simulated clock per generated value. */
export const arbSimulatedClock: fc.Arbitrary<SimulatedClock> = arbClockStart.map(
  (start) => new SimulatedClock(start),
);
