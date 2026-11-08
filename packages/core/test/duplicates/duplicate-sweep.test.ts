import {
  agencyScope,
  CROSS_AGENCY_OPEN_COUNTER,
  duplicateReportId,
  emptySweepCounts,
  InProcessDuplicateSweepStarter,
  LISTING_COUNTER_CODES,
  manualSweepName,
  DuplicateSweep,
  PLATFORM_SCOPE,
  runDuplicateSweep,
  sumSweepCounts,
  sweepActor,
  toManagedListingItem,
} from '@open-estate/core';
import { DEFAULT_DUPLICATE_CONFIG, duplicateFlagOf } from '@open-estate/shared';
import { duplicatePlatform, member, platformAdmin } from './support/duplicate-harness';

// Duplikat_Abgleich (duplicate-detection Req 10, 11, 12.4): examples of each phase.

const content = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  originalLocale: 'de',
  title: 'Helle Altbauwohnung mit Balkon',
  description: 'Drei Zimmer, Blick in den Hof.',
  translations: [],
  offers: [{ offerType: 'SALE', price: '350000.00', currency: 'EUR' }],
  listingType: 'apartment_unit',
  rooms: 3,
  area: '85.50',
  address: { city: 'Berlin', postalCode: '10115', country: 'DE', street: 'Hauptstraße 12' },
  media: [],
  tours: [],
  ...overrides,
});

const other = content({
  title: 'Reihenhaus am Stadtrand',
  description: 'Garten, Garage.',
  listingType: 'terraced',
  rooms: 5,
  area: '140.00',
  address: { city: 'Hamburg', postalCode: '22111', country: 'DE', street: 'Lindenweg 3' },
});

type Platform = ReturnType<typeof duplicatePlatform>;

async function create(p: Platform, agencyId: string, body: Record<string, unknown>) {
  const result = await p.commands.create(member(agencyId), { content: body });
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

async function flagOf(p: Platform, id: string) {
  return (await p.get(id))?.management.flags?.find((f) => f.code === 'DUPLICATE');
}

/** Rewrites a stored listing outside the writer, e.g. a migration (no profile update). */
async function overwriteOutsideWriter(p: Platform, id: string, body: Record<string, unknown>) {
  const stored = await p.get(id);
  if (stored === null) throw new Error('missing');
  const donor = await create(p, 'agy-b', body);
  const source = await p.get(donor.id);
  if (source === null) throw new Error('missing');
  const { id: _id, ...fields } = source.listing;
  void _id;
  p.listings.putRaw(
    toManagedListingItem(
      { ...stored.listing, ...fields, id },
      {
        ...stored.management,
        version: stored.management.version + 1,
        contentHash: source.management.contentHash,
      },
    ),
  );
  // The donor is gone again without any cleanup (its index data is orphaned).
  p.listings.remove(donor.id);
}

describe('Duplikat_Abgleich', () => {
  it('flags a duplicate that the write path could not see (Req 10.3, 10.4)', async () => {
    const p = duplicatePlatform();
    const first = await create(p, 'agy-a', content());
    const second = await create(p, 'agy-a', other);
    // Outside the writer, the second listing becomes a copy of the first one.
    await overwriteOutsideWriter(p, second.id, content());
    const before = await p.get(second.id);

    const summary = await p.sweep();

    const after = await p.get(second.id);
    expect(after?.management.version).toBe(before?.management.version);
    expect(after?.management.status).toBe(before?.management.status);
    expect(await flagOf(p, second.id)).toMatchObject({
      detectedBy: 'SWEEP',
      originalId: first.id,
    });
    expect(await flagOf(p, first.id)).toBeUndefined();
    expect(summary).toMatchObject({
      event: 'duplicate.sweep',
      status: 'SUCCEEDED',
      flagsSet: 1,
      orphansRemoved: 1,
    });
    expect(summary.indexed).toBeGreaterThanOrEqual(1);
    // The profile follows the stored version again.
    expect((await p.index.getProfile(second.id))?.listingVersion).toBe(after?.management.version);
    // Audited with the system actor, codes only (Req 7.7, 12.2).
    expect(p.audit.entries.at(-1)).toMatchObject({
      action: 'listing.flag.set',
      actor: { kind: 'system', job: 'duplicate-sweep' },
      target: `listing/${second.id}`,
      agencyId: 'agy-a',
      details: { flag: 'DUPLICATE', originalId: first.id },
    });
    expect(await p.counters.get(agencyScope('agy-a'), LISTING_COUNTER_CODES.duplicateFlags)).toBe(
      1,
    );
    // A second run changes nothing.
    const again = await p.sweep();
    expect(again).toMatchObject({ indexed: 0, flagsSet: 0, flagsUpdated: 0, flagsRemoved: 0 });
  });

  it('removes a Markierung whose Original is gone and prunes Verwerfungen (Req 12.4)', async () => {
    const p = duplicatePlatform();
    const first = await create(p, 'agy-a', content());
    const second = await create(p, 'agy-a', content());
    const third = await create(p, 'agy-a', content());
    // The third one is released against the first two.
    const released = await p.commands.dismissFlag(member('agy-a'), third.id, 'DUPLICATE');
    expect(released.ok).toBe(true);
    expect((await p.index.getProfile(third.id))?.dismissed.sort()).toEqual(
      [first.id, second.id].sort(),
    );
    // The first one disappears without any cleanup.
    p.listings.remove(first.id);

    const summary = await p.sweep();

    expect(summary.orphansRemoved).toBe(1);
    expect(summary.dismissalsPruned).toBe(1);
    expect(await p.index.getProfile(first.id)).toBeNull();
    expect((await p.index.getProfile(third.id))?.dismissed).toEqual([second.id]);
    // The second one has no older Treffer left; the exact key has a living owner again.
    expect(await flagOf(p, second.id)).toBeUndefined();
    expect(summary.flagsRemoved).toBe(1);
    const profile = await p.index.getProfile(second.id);
    expect(await p.index.exactOwner(agencyScope('agy-a'), profile?.profile.exactKey ?? '')).toBe(
      second.id,
    );
    expect(profile?.exactClaimed).toBe(true);
    expect(summary.exactClaimed).toBe(1);
    expect(summary.exactReleased).toBe(0);
  });

  it('applies changed rules to every profile (Req 10.6)', async () => {
    const p = duplicatePlatform();
    const first = await create(p, 'agy-a', content());
    await create(p, 'agy-a', other);
    const rulesBefore = (await p.index.getProfile(first.id))?.profile.rules;
    const stricter = { ...DEFAULT_DUPLICATE_CONFIG, textNearHamming: 1 };

    const summary = await p.sweep(stricter);

    expect(summary.indexed).toBe(2);
    const rulesAfter = (await p.index.getProfile(first.id))?.profile.rules;
    expect(rulesAfter).not.toBe(rulesBefore);
    expect((await p.sweep(stricter)).indexed).toBe(0);
  });

  it('keeps Agenturübergreifende_Treffer apart from listings (Req 11.1, 11.2, 11.5, 11.6)', async () => {
    const p = duplicatePlatform();
    const a = await create(p, 'agy-a', content());
    const b = await create(p, 'agy-b', content());
    const beforeA = await p.get(a.id);
    const beforeB = await p.get(b.id);

    const first = await p.sweep();

    const reportId = duplicateReportId(a.id, b.id);
    const [report] = p.reports.all();
    expect(report).toMatchObject({
      reportId,
      listingA: a.id < b.id ? a.id : b.id,
      listingB: a.id < b.id ? b.id : a.id,
      state: 'OPEN',
      reasons: ['EXACT'],
    });
    expect(first.reportsNew).toBe(1);
    expect(await p.counters.get(PLATFORM_SCOPE, CROSS_AGENCY_OPEN_COUNTER)).toBe(1);
    // Neither listing changed (Req 11.2).
    expect(await p.get(a.id)).toEqual(beforeA);
    expect(await p.get(b.id)).toEqual(beforeB);
    expect(await p.index.reportRefs(a.id)).toEqual([reportId]);
    expect(await p.index.reportRefs(b.id)).toEqual([reportId]);

    // Dismissed Treffer stay dismissed (Req 11.5).
    const dismissed = await p.reportService.dismiss(platformAdmin, reportId);
    expect(dismissed.ok && dismissed.value.state).toBe('DISMISSED');
    expect(await p.counters.get(PLATFORM_SCOPE, CROSS_AGENCY_OPEN_COUNTER)).toBe(0);
    await p.sweep();
    expect(p.reports.all()[0]?.state).toBe('DISMISSED');

    // A new pair that stops matching is resolved (Req 11.6).
    const c = await create(p, 'agy-b', other);
    const d = await create(p, 'agy-a', other);
    await p.sweep();
    const pair = duplicateReportId(c.id, d.id);
    expect((await p.reports.get(pair))?.state).toBe('OPEN');
    const stored = await p.get(d.id);
    const edit = await p.commands.replaceContent(member('agy-a'), d.id, {
      content: content({
        title: 'Loft im Hafen',
        description: 'Offen, hell.',
        listingType: 'loft',
        rooms: 2,
        area: '60.00',
        address: { city: 'Bremen', postalCode: '28195', country: 'DE', street: 'Kaje 1' },
      }),
      baseVersion: stored?.management.version,
    });
    expect(edit.ok).toBe(true);
    const last = await p.sweep();
    expect(last.reportsResolved).toBe(1);
    expect((await p.reports.get(pair))?.state).toBe('RESOLVED');
    expect(await p.counters.get(PLATFORM_SCOPE, CROSS_AGENCY_OPEN_COUNTER)).toBe(0);

    // A listing that disappears takes its Treffer along (Req 12.4); the counter follows.
    const e = await create(p, 'agy-a', other);
    await p.sweep();
    const ce = duplicateReportId(c.id, e.id);
    expect((await p.reports.get(ce))?.state).toBe('OPEN');
    expect(await p.counters.get(PLATFORM_SCOPE, CROSS_AGENCY_OPEN_COUNTER)).toBe(1);
    p.listings.remove(e.id);
    await p.sweep();
    expect(await p.reports.get(ce)).toBeNull();
    expect(await p.counters.get(PLATFORM_SCOPE, CROSS_AGENCY_OPEN_COUNTER)).toBe(0);
    expect(await p.index.reportRefs(c.id)).not.toContain(ce);
  });

  it('does not overwrite what a concurrent write set (Req 10.5)', async () => {
    const p = duplicatePlatform();
    const first = await create(p, 'agy-a', content());
    const second = await create(p, 'agy-a', other);
    await overwriteOutsideWriter(p, second.id, content());
    await p.sweep();
    expect((await flagOf(p, second.id))?.originalId).toBe(first.id);
    // Outside the writer again: both become different listings, so the next run would remove
    // the Markierung — but right after the run read the listings, the writer edits the second
    // one back into a copy of the first (its own Markierung, detected by `UPDATE`).
    await overwriteOutsideWriter(p, second.id, other);
    const deps = p.sweepDeps();
    let edited = false;
    const sweep = new DuplicateSweep({
      ...deps,
      listings: {
        checkOp: (id, version) => p.listings.checkOp(id, version),
        scan: (request) => p.listings.scan(request),
        existing: (ids) => p.listings.existing(ids),
        getMany: async (ids) => {
          const read = await p.listings.getMany(ids);
          if (!edited && ids.includes(second.id)) {
            edited = true;
            const current = read.get(second.id);
            const result = await p.commands.replaceContent(member('agy-a'), second.id, {
              content: content({ title: 'Helle Altbauwohnung, Balkon' }),
              baseVersion: current?.management.version,
            });
            expect(result.ok).toBe(true);
          }
          return read;
        },
      },
    });
    const statusBefore = (await p.get(second.id))?.management.status;

    const summary = await runDuplicateSweep(
      sweep,
      { sweepId: 'run-x', startedAt: '2026-03-01T00:00:00.000Z' },
      1,
    );

    expect(edited).toBe(true);
    expect(summary.skipped).toBeGreaterThanOrEqual(1);
    const after = await p.get(second.id);
    expect(after?.management.status).toBe(statusBefore);
    expect(duplicateFlagOf(after?.management.flags ?? [])).toMatchObject({
      detectedBy: 'UPDATE',
      originalId: first.id,
    });
    // The next run confirms the writer's Markierung without changing it.
    const next = await p.sweep();
    expect(next).toMatchObject({ flagsSet: 0, flagsUpdated: 0, flagsRemoved: 0 });
  });

  it('skips a listing whose version changed after its profile was scanned (Req 10.5)', async () => {
    const p = duplicatePlatform();
    const original = await create(p, 'agy-a', content());
    const moved = await create(p, 'agy-b', content());
    await p.sweep();
    // Between the scan of the profiles and the read of the listings, a Plattform_Admin moves
    // the younger copy into the agency of the original: the writer flags it there.
    let assigned = false;
    const deps = p.sweepDeps();
    const sweep = new DuplicateSweep({
      ...deps,
      index: Object.assign(Object.create(p.index) as typeof p.index, {
        scan: async (request: Parameters<typeof p.index.scan>[0]) => {
          const page = await p.index.scan(request);
          const scanned = page.items.some(
            (e) => e.kind === 'profile' && e.profile.listingId === moved.id,
          );
          if (!assigned && scanned) {
            assigned = true;
            const current = await p.get(moved.id);
            const result = await p.commands.assignAgency(platformAdmin, moved.id, {
              agencyId: 'agy-a',
              baseVersion: current?.management.version,
            });
            expect(result.ok).toBe(true);
          }
          return page;
        },
      }),
    });
    expect((await flagOf(p, moved.id)) ?? null).toBeNull();
    const run = { sweepId: 'run-y', startedAt: '2026-03-01T00:00:00.000Z' };
    let cursor: string | undefined;
    do {
      const result = await sweep.step(run, {
        phase: 'MATCH',
        segment: 0,
        segments: 1,
        ...(cursor !== undefined && { cursor }),
      });
      cursor = result.cursor;
    } while (cursor !== undefined);
    // The stale profile (other agency) must not decide: the writer's Markierung stays.
    expect(await flagOf(p, moved.id)).toMatchObject({
      detectedBy: 'UPDATE',
      originalId: original.id,
    });
  });

  it('does not undo a Verwerfung made while the run decided (Req 8.3, 10.5)', async () => {
    const p = duplicatePlatform();
    const first = await create(p, 'agy-a', content());
    const second = await create(p, 'agy-a', content({ title: 'Helle Altbauwohnung, Balkon' }));
    expect((await flagOf(p, second.id))?.originalId).toBe(first.id);
    // Outside the writer the original becomes an exact copy: the Markierung would change.
    await overwriteOutsideWriter(p, first.id, content({ title: 'Helle Altbauwohnung, Balkon' }));
    let dismissed = false;
    const deps = p.sweepDeps();
    const sweep = new DuplicateSweep({
      ...deps,
      listings: {
        checkOp: (id, version) => p.listings.checkOp(id, version),
        scan: (request) => p.listings.scan(request),
        existing: (ids) => p.listings.existing(ids),
        getMany: async (ids) => {
          const read = await p.listings.getMany(ids);
          if (!dismissed && ids.includes(second.id)) {
            dismissed = true;
            const result = await p.commands.dismissFlag(member('agy-a'), second.id, 'DUPLICATE');
            expect(result.ok).toBe(true);
          }
          return read;
        },
      },
    });

    const summary = await runDuplicateSweep(
      sweep,
      { sweepId: 'run-z', startedAt: '2026-03-01T00:00:00.000Z' },
      1,
    );

    expect(dismissed).toBe(true);
    expect(summary.skipped).toBeGreaterThanOrEqual(1);
    expect(await flagOf(p, second.id)).toBeUndefined();
    // And the next run respects the Verwerfung.
    await p.sweep();
    expect(await flagOf(p, second.id)).toBeUndefined();
  });

  it('ends a step on the time budget and continues from the cursor', async () => {
    const p = duplicatePlatform();
    for (let i = 0; i < 8; i += 1) await create(p, 'agy-a', i % 2 === 0 ? content() : other);
    const sweep = p.sweepFor();
    const run = { sweepId: 'run-2', startedAt: '2026-03-01T00:00:00.000Z' };
    const first = await sweep.step(run, { phase: 'MATCH', segment: 0, segments: 1 }, () => true);
    expect(first.cursor).toBeDefined();
    let counts = first.counts;
    let cursor = first.cursor;
    while (cursor !== undefined) {
      const next = await sweep.step(run, { phase: 'MATCH', segment: 0, segments: 1, cursor });
      counts = sumSweepCounts([counts, next.counts]);
      cursor = next.cursor;
    }
    expect(counts.checked).toBe(8);
    expect(sumSweepCounts([])).toEqual(emptySweepCounts());
  });
});

describe('starting a run', () => {
  it('runs one Abgleich at a time in process and names it manual-{timestamp} (Req 10.2)', async () => {
    let release: () => void = () => undefined;
    const runs: string[] = [];
    const starter = new InProcessDuplicateSweepStarter({
      clock: () => Date.parse('2026-03-01T03:00:00.000Z'),
      run: (sweepId) => {
        runs.push(sweepId);
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    });
    const first = await starter.start();
    expect(first).toEqual({ executionName: 'manual-20260301T030000-000Z', alreadyRunning: false });
    expect(await starter.start()).toEqual({ ...first, alreadyRunning: true });
    release();
    await starter.idle();
    expect((await starter.start()).alreadyRunning).toBe(false);
    expect(runs).toHaveLength(2);
    expect(manualSweepName(0)).toMatch(/^manual-[0-9A-Za-z-]+$/);
  });

  it('audits the start and allows it only with platform:operate', async () => {
    const p = duplicatePlatform();
    const denied = await p.reportService.startSweep(member('agy-a'));
    expect(denied).toEqual({
      ok: false,
      error: { code: 'FORBIDDEN', message: 'Missing permission platform:operate' },
    });
    const started = await p.reportService.startSweep(platformAdmin);
    expect(started.ok).toBe(true);
    expect(p.audit.entries.at(-1)).toMatchObject({
      action: 'duplicate-sweep.start',
      actor: { kind: 'user', userId: platformAdmin.kind === 'user' ? platformAdmin.userId : '' },
      result: 'SUCCESS',
    });
  });

  it('uses the system actor for its audit entries', () => {
    expect(sweepActor('run-1')).toEqual({ kind: 'system', job: 'duplicate-sweep', runId: 'run-1' });
  });
});
