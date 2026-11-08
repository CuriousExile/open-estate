import { ConfigError, type SweepSummary } from '@open-estate/core';
import {
  createDuplicateSweepHandler,
  createDuplicateSweepHandlerFromEnv,
  DUPLICATE_SWEEP_ENV,
  SWEEP_TIME_RESERVE_MS,
  type SweepRunState,
  type SweepStepState,
} from '@open-estate/management';
import { duplicatePlatform, member } from '../../core/test/duplicates/support/duplicate-harness';

// Tasks of the `DuplicateSweep` state machine (duplicate-detection Req 10): the handler driven
// like Step Functions drives it — Prepare, one Map per phase with a cursor loop per segment, the
// RESOLVE loop, Finish.

const content = (overrides: Record<string, unknown> = {}) => ({
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

function setup(
  remaining: () => number = () => 14 * 60 * 1000,
  enabled: () => boolean = () => true,
) {
  const platform = duplicatePlatform();
  const logs: SweepSummary[] = [];
  const metrics: SweepSummary[] = [];
  const loads: string[] = [];
  const handler = createDuplicateSweepHandler({
    clock: platform.clock,
    log: (summary) => logs.push(summary),
    metrics: (summary) => metrics.push(summary),
    async sweepFor(sweepId) {
      loads.push(sweepId);
      return { sweep: platform.sweepFor(), segments: 3, enabled: enabled() };
    },
  });
  const context = { getRemainingTimeInMillis: remaining };
  const invoke = (event: unknown) => handler(event, context);
  return { platform, logs, metrics, loads, invoke };
}

/** The state machine of `duplicate-sweep.ts`, in process. */
async function runLikeStepFunctions(
  invoke: (event: unknown) => Promise<unknown>,
  sweepId: string,
): Promise<{ summary: SweepSummary; steps: number }> {
  const run = (await invoke({
    action: 'prepare',
    sweepId,
    startedAt: '2026-03-01T03:00:00.000Z',
  })) as SweepRunState;
  let steps = 0;
  const results: Record<string, { counts: unknown }> = {};
  for (const [phase, key] of [
    ['INDEX', 'index'],
    ['ORPHAN', 'orphan'],
    ['MATCH', 'match'],
  ] as const) {
    const counts: unknown[] = [];
    for (const segment of run.segments) {
      let state = { action: 'step', run, phase, segment } as unknown as SweepStepState;
      do {
        state = (await invoke(state)) as SweepStepState;
        steps += 1;
      } while (!state.done);
      counts.push(state.counts);
    }
    results[key] = { counts };
  }
  let resolve = { action: 'step', run, phase: 'RESOLVE', segment: 0 } as unknown as SweepStepState;
  do {
    resolve = (await invoke(resolve)) as SweepStepState;
    steps += 1;
  } while (!resolve.done);
  results['resolve'] = { counts: resolve.counts };
  const summary = (await invoke({ action: 'finish', run, results })) as SweepSummary;
  return { summary, steps };
}

describe('duplicate sweep task handler', () => {
  it('runs a whole Abgleich and logs its summary once (Req 10.3, 10.7)', async () => {
    const { platform, logs, metrics, loads, invoke } = setup();
    const a = await platform.commands.create(member('agy-a'), { content: content() });
    await platform.commands.create(member('agy-b'), { content: content() });
    expect(a.ok).toBe(true);

    const { summary } = await runLikeStepFunctions(invoke, 'scheduled-1');

    expect(summary).toMatchObject({
      event: 'duplicate.sweep',
      sweepId: 'scheduled-1',
      status: 'SUCCEEDED',
      startedAt: '2026-03-01T03:00:00.000Z',
      checked: 2,
      reportsNew: 1,
    });
    expect(logs).toEqual([summary]);
    expect(metrics).toEqual([summary]);
    // The configuration is read once per run (Req 10.6), again for the next run.
    expect(loads).toEqual(['scheduled-1']);
    await runLikeStepFunctions(invoke, 'manual-2');
    expect(loads).toEqual(['scheduled-1', 'manual-2']);
  });

  it('returns after one page when the time budget is used up, with a cursor', async () => {
    const { platform, invoke } = setup(() => SWEEP_TIME_RESERVE_MS - 1);
    for (let i = 0; i < 12; i += 1) {
      await platform.commands.create(member('agy-a'), {
        content: content({ title: `Wohnung ${i}`, rooms: 1 + i }),
      });
    }
    const { summary, steps } = await runLikeStepFunctions(invoke, 'slow-1');
    expect(summary.checked).toBe(12);
    // At least one part needed more than one step.
    expect(steps).toBeGreaterThan(3 * 3 + 1);
  });

  it('ends at Prepare and logs SKIPPED while the detection is switched off', async () => {
    const { platform, logs, metrics, invoke } = setup(undefined, () => false);
    await platform.commands.create(member('agy-a'), { content: content() });
    const prepared = await invoke({
      action: 'prepare',
      sweepId: 'scheduled-3',
      startedAt: '2026-03-01T03:00:00.000Z',
    });
    // The state machine's Choice `DetectionEnabled` ends the run on `enabled: false`.
    expect(prepared).toMatchObject({ sweepId: 'scheduled-3', enabled: false });
    expect(logs).toEqual([
      expect.objectContaining({ status: 'SKIPPED', sweepId: 'scheduled-3', checked: 0 }),
    ]);
    expect(metrics).toEqual([]);
    expect(await platform.index.getProfile(platform.listings.all()[0]?.id ?? '')).not.toBeNull();
  });

  it('logs a failed run without counts (Req 10.8)', async () => {
    const { logs, invoke } = setup();
    const summary = await invoke({
      action: 'fail',
      sweepId: 'scheduled-2',
      startedAt: '2026-03-01T03:00:00.000Z',
    });
    expect(summary).toMatchObject({ status: 'FAILED', sweepId: 'scheduled-2', checked: 0 });
    expect(logs).toHaveLength(1);
  });

  it('rejects malformed events', async () => {
    const { invoke } = setup();
    await expect(invoke({ action: 'step' })).rejects.toThrow();
    await expect(invoke({ action: 'nope' })).rejects.toThrow();
  });

  it('does not cache a failed configuration load', async () => {
    let attempts = 0;
    const platform = duplicatePlatform();
    const handler = createDuplicateSweepHandler({
      clock: platform.clock,
      log: () => undefined,
      async sweepFor() {
        attempts += 1;
        if (attempts === 1) throw new ConfigError('CONFIG_INVALID', ['duplicate-detection.json']);
        return { sweep: platform.sweepFor(), segments: 1, enabled: true };
      },
    });
    const prepare = { action: 'prepare', sweepId: 'r', startedAt: '2026-03-01T03:00:00.000Z' };
    const context = { getRemainingTimeInMillis: () => 60_000 };
    await expect(handler(prepare, context)).rejects.toBeInstanceOf(ConfigError);
    await expect(handler(prepare, context)).resolves.toMatchObject({ segments: [0] });
  });

  it('names every missing variable', () => {
    expect(() => createDuplicateSweepHandlerFromEnv({})).toThrow(ConfigError);
    try {
      createDuplicateSweepHandlerFromEnv({});
    } catch (error) {
      expect((error as ConfigError).names).toEqual(
        expect.arrayContaining(Object.values(DUPLICATE_SWEEP_ENV)),
      );
    }
  });
});
