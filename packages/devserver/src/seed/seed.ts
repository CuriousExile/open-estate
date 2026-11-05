import {
  connectorConfigSchema,
  type ConnectorConfig,
  type ConnectorRunSummary,
} from '@open-estate/ingestion';
import {
  contentToInput,
  formatUsageLine,
  handleUsageBatch,
  type UsageLogEvent,
} from '@open-estate/core';
import type { ApiError, Principal, Result } from '@open-estate/shared';
import type { DevPlatform } from '../platform';
import { DEMO_FEED_MODULE } from './demo-connector';
import {
  AGENCIES,
  CRM_INVALID_RECORDS,
  CRM_RECORDS,
  MANUAL_LISTINGS,
  markDemoContent,
  USERS,
  type ContentInput,
  type SeedUser,
} from './demo-data';

// DEV ONLY: seeds the in-memory platform through its real use cases, so versions, field
// provenance, counters, connector runs and the audit log are consistent with what the platform
// would have produced. The demo clock is moved through the last four weeks while seeding.

const DAY_MS = 86_400_000;

/** Batches the demo CRM connector replays, in run order. */
export const CRM_BATCHES = [
  // Run 1: initial import — four listings, one record with an unknown listing type.
  [
    CRM_RECORDS.winterhude,
    CRM_RECORDS.charlottenburg,
    CRM_RECORDS.rostock,
    CRM_RECORDS.bremen,
    CRM_INVALID_RECORDS.unknownType,
  ],
  // Run 2: price drop and new description (IMPORT versions), one unchanged, two rejections.
  [
    {
      ...CRM_RECORDS.winterhude,
      offers: [{ offerType: 'SALE', price: '799000.00', currency: 'EUR' }],
    },
    CRM_RECORDS.charlottenburg,
    {
      ...CRM_RECORDS.rostock,
      description:
        'Vermietete Ferienwohnung mit Ostseeblick und Stellplatz – ideal als Kapitalanlage.',
    },
    CRM_INVALID_RECORDS.negativeArea,
    CRM_INVALID_RECORDS.noIdentity,
  ],
  // Run 3: the source fails after one record (run status FAILURE).
  [CRM_RECORDS.charlottenburg, CRM_RECORDS.bremen],
  // Run 4: nothing changed.
  [CRM_RECORDS.charlottenburg, CRM_RECORDS.bremen],
] as const;

export const CRM_CONNECTOR_ID = 'nordlicht-crm';

export interface SeedSummary {
  /** Full `oem_…` credential of the demo machine access (shown once, like in the portal). */
  machineCredential: string;
  listingIds: Record<string, string>;
  runs: ConnectorRunSummary[];
}

function principalOf(user: SeedUser): Principal {
  if (user.role === 'PLATFORM_ADMIN') {
    return { kind: 'user', userId: user.userId, displayName: user.displayName, role: user.role };
  }
  return {
    kind: 'user',
    userId: user.userId,
    displayName: user.displayName,
    role: user.role,
    agencyId: user.agencyId ?? '',
  };
}

function unwrap<T>(what: string, result: Result<T, ApiError | readonly ApiError[]>): T {
  if (result.ok) return result.value;
  throw new Error(`Seeding failed at ${what}: ${JSON.stringify(result.error)}`);
}

/** Deterministic PRNG (mulberry32), so every start shows the same usage numbers. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export async function seedDemo(
  platform: DevPlatform,
  now: number = Date.now(),
): Promise<SeedSummary> {
  const { clock, services, stores } = platform;
  const midnight = Math.floor(now / DAY_MS) * DAY_MS;
  /** `daysAgo` days before today at `hh:mm` UTC. */
  const at = (daysAgo: number, hh: number, mm = 0) =>
    midnight - daysAgo * DAY_MS + (hh * 60 + mm) * 60_000;

  const admin = principalOf(USERS.platformAdmin);
  const anna = principalOf(USERS.agencyAdmin);
  const max = principalOf(USERS.agencyMember);
  const sepp = principalOf(USERS.suspendedAdmin);
  const asAdmin = { principal: admin, channel: 'ADMIN' as const };
  const asAnna = { principal: anna, channel: 'PORTAL' as const };

  // ---- identities (day 30) -----------------------------------------------------------------
  clock.set(at(30, 8));
  const created = new Date(clock.now()).toISOString();
  // Bootstrap of the first Plattform_Admin, as the IdentityStack's trigger does it.
  const bootstrap = await stores.transactor.transact([
    stores.memberships.createOp({
      userId: USERS.platformAdmin.userId,
      email: USERS.platformAdmin.email,
      displayName: USERS.platformAdmin.displayName,
      role: 'PLATFORM_ADMIN',
      createdAt: created,
    }),
    stores.platformCounters.adjustPlatformAdminsOp(1),
  ]);
  if (!bootstrap.ok) throw new Error('Seeding failed at platform admin bootstrap');
  for (const agency of Object.values(AGENCIES)) {
    // Fixed ids keep the demo URLs stable (the AgencyService would assign UUIDs).
    await stores.agencies.create({
      ...agency,
      state: 'ACTIVE',
      createdAt: created,
      agencyAdmins: 0,
    });
  }
  clock.set(at(30, 8, 10));
  unwrap(
    'add Anna',
    await services.memberships.addMember(asAdmin, AGENCIES.nordlicht.agencyId, {
      email: USERS.agencyAdmin.email,
      role: 'AGENCY_ADMIN',
    }),
  );
  unwrap(
    'add Sepp',
    await services.memberships.addMember(asAdmin, AGENCIES.alpenblick.agencyId, {
      email: USERS.suspendedAdmin.email,
      role: 'AGENCY_ADMIN',
    }),
  );
  clock.set(at(29, 9));
  unwrap(
    'add Max',
    await services.memberships.addMember(asAnna, AGENCIES.nordlicht.agencyId, {
      email: USERS.agencyMember.email,
      role: 'AGENCY_MEMBER',
    }),
  );

  // ---- manual listings ---------------------------------------------------------------------
  const ids: Record<string, string> = {};
  const contents: Record<string, ContentInput> = {};
  const ordered = [...MANUAL_LISTINGS].sort((a, b) => b.daysAgo - a.daysAgo);
  for (const [index, seed] of ordered.entries()) {
    const author = seed.agency === 'alpenblick' ? sepp : index % 2 === 0 ? max : anna;
    const content = markDemoContent(seed.content);
    clock.set(at(seed.daysAgo, 9, index));
    const view = unwrap(
      `create ${seed.key}`,
      await services.commands.create(author, {
        content,
        status: 'INACTIVE',
        ...(seed.customId !== undefined && { customId: seed.customId }),
      }),
    );
    ids[seed.key] = view.id;
    contents[seed.key] = content;
    if (seed.status === 'ACTIVE') {
      clock.set(at(seed.daysAgo, 11, index));
      const publisher = seed.agency === 'alpenblick' ? sepp : anna;
      unwrap(
        `activate ${seed.key}`,
        await services.commands.setStatus(publisher, view.id, { status: 'ACTIVE' }),
      );
    }
  }

  const current = async (key: string) => {
    const managed = await stores.listings.get(ids[key] ?? '');
    if (managed === null) throw new Error(`Seeding: listing ${key} missing`);
    return managed.management.version;
  };
  const replace = async (key: string, who: Principal, content: ContentInput) => {
    contents[key] = content;
    unwrap(
      `update ${key}`,
      await services.commands.replaceContent(who, ids[key] ?? '', {
        content,
        baseVersion: await current(key),
      }),
    );
  };

  // Berlin-Mitte: price reduction, later a longer description with a fourth photo.
  const mitte = contents['berlin-mitte'] ?? {};
  clock.set(at(20, 14));
  await replace('berlin-mitte', anna, {
    ...mitte,
    offers: [{ offerType: 'SALE', price: '469000.00', currency: 'EUR' }],
  });
  clock.set(at(8, 10, 30));
  await replace('berlin-mitte', max, {
    ...(contents['berlin-mitte'] ?? {}),
    description:
      'Altbau mit Stuck, Dielenboden und Südbalkon. Ruhige Seitenstraße, fünf Minuten zur U-Bahn. ' +
      'Neu: Badezimmer 2025 saniert, Kellerabteil inklusive.',
    media: [
      ...((mitte['media'] as unknown[] | undefined) ?? []),
      { url: 'https://example.org/open-estate/demo/berlin-mitte/photo-4.jpg' },
    ],
  });

  // Prenzlauer Berg: rent increase, then restored to the original content.
  clock.set(at(14, 16));
  await replace('berlin-prenzlauer-berg', max, {
    ...(contents['berlin-prenzlauer-berg'] ?? {}),
    offers: [
      {
        offerType: 'RENT',
        coldRent: '1590.00',
        additionalCosts: '230.00',
        warmRent: '1820.00',
        currency: 'EUR',
      },
    ],
  });
  clock.set(at(13, 9, 15));
  unwrap(
    'restore berlin-prenzlauer-berg',
    await services.commands.restore(anna, ids['berlin-prenzlauer-berg'] ?? '', {
      version: 1,
      baseVersion: await current('berlin-prenzlauer-berg'),
    }),
  );

  // HafenCity: briefly taken offline and published again.
  clock.set(at(7, 9));
  unwrap(
    'deactivate hamburg-hafencity',
    await services.commands.setStatus(anna, ids['hamburg-hafencity'] ?? '', { status: 'INACTIVE' }),
  );
  clock.set(at(6, 17));
  unwrap(
    'reactivate hamburg-hafencity',
    await services.commands.setStatus(anna, ids['hamburg-hafencity'] ?? '', { status: 'ACTIVE' }),
  );

  // ---- connector runs (CRM feed of Nordlicht) ------------------------------------------------
  const connector: ConnectorConfig = connectorConfigSchema.parse({
    id: CRM_CONNECTOR_ID,
    type: 'external-api',
    module: DEMO_FEED_MODULE,
    enabled: true,
    schedule: 'rate(1 day)',
    agencyId: AGENCIES.nordlicht.agencyId,
  });
  const runs: ConnectorRunSummary[] = [];
  const runAt = async (daysAgo: number, batch: number, failAfter?: number) => {
    clock.set(at(daysAgo, 6, 30));
    const day = new Date(clock.now()).toISOString().slice(0, 10);
    runs.push(
      await platform.runConnector(
        { ...connector, settings: { batch, ...(failAfter !== undefined && { failAfter }) } },
        { runId: `${CRM_CONNECTOR_ID}-${day}` },
      ),
    );
  };
  await runAt(20, 0);
  await runAt(9, 1);
  // A portal edit of an imported listing: the title is now PORTAL, the offers stay IMPORT.
  const winterhudeId =
    (await stores.keys.get(AGENCIES.nordlicht.agencyId, CRM_RECORDS.winterhude.customId)) ?? '';
  ids['crm-winterhude'] = winterhudeId;
  const winterhude = await stores.listings.get(winterhudeId);
  if (winterhude !== null) {
    clock.set(at(5, 11));
    unwrap(
      'portal edit of CRM-4711',
      await services.commands.replaceContent(max, winterhudeId, {
        content: {
          ...contentToInput(winterhude.listing),
          title: '4-Zimmer-Wohnung mit Alsterblick – provisionsfrei',
        },
        baseVersion: winterhude.management.version,
      }),
    );
  }
  await runAt(2, 2, 1);
  await runAt(1, 3);
  for (const record of Object.values(CRM_RECORDS)) {
    const id = await stores.keys.get(AGENCIES.nordlicht.agencyId, record.customId);
    if (id !== null) ids[`crm-${record.customId}`] = id;
  }

  // ---- machine accesses --------------------------------------------------------------------
  clock.set(at(16, 15));
  const legacy = unwrap(
    'create legacy machine access',
    await services.machineAccess.create(asAnna, AGENCIES.nordlicht.agencyId, {
      label: 'Altes Export-Skript',
      permissions: ['listing:read'],
    }),
  );
  clock.set(at(11, 10));
  unwrap(
    'revoke legacy machine access',
    await services.machineAccess.revoke(asAnna, AGENCIES.nordlicht.agencyId, legacy.keyId),
  );
  clock.set(at(4, 10));
  const crmAccess = unwrap(
    'create CRM machine access',
    await services.machineAccess.create(asAnna, AGENCIES.nordlicht.agencyId, {
      label: 'CRM-Sync (Demo)',
      permissions: ['listing:read', 'listing:write', 'listing:status', 'monitoring:read'],
    }),
  );

  // ---- suspension of Alpenblick (day 3) ------------------------------------------------------
  clock.set(at(3, 12));
  unwrap(
    'suspend Alpenblick',
    await services.agencies.update(
      asAdmin,
      AGENCIES.alpenblick.agencyId,
      { state: 'SUSPENDED' },
      { dryRun: false },
    ),
  );

  // ---- usage counters (last 14 days, in AWS: UsageAggregator) --------------------------------
  const rand = random(20_261_105);
  const all = stores.listings.all();
  const events: UsageLogEvent[] = [];
  for (let daysAgo = 14; daysAgo >= 0; daysAgo--) {
    const noon = at(daysAgo, 12);
    const visible = all
      .filter((item) => item.status === 'ACTIVE' && Date.parse(item.updatedAt) <= noon)
      .map((item) => ({
        id: item.id,
        ...(item.agencyId !== undefined && { agencyId: item.agencyId }),
      }));
    if (visible.length === 0) continue;
    const pages = 4 + Math.floor(rand() * 10);
    for (let page = 0; page < pages; page++) {
      events.push({
        timestamp: noon + page * 60_000,
        message: formatUsageLine('impression', visible),
      });
    }
    for (const item of visible) {
      const views = Math.floor(rand() * 9);
      for (let view = 0; view < views; view++) {
        events.push({
          timestamp: noon + view * 30_000,
          message: formatUsageLine('detail', [item]),
        });
      }
    }
  }
  await handleUsageBatch(events, { counters: stores.counters });

  clock.release();
  return { machineCredential: crmAccess.secret, listingIds: ids, runs };
}
