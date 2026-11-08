import { GetParametersCommand, PutParameterCommand, type SSMClient } from '@aws-sdk/client-ssm';
import {
  ConfigError,
  DUPLICATE_DETECTION_CACHE_TTL_MS,
  DuplicateReportService,
  LISTING_COUNTER_CODES,
  SsmDuplicateDetectionSetting,
  agencyScope,
  parseDuplicateDetectionMode,
} from '@open-estate/core';
import type { ListingView } from '@open-estate/shared';
import {
  duplicatePlatform,
  member,
  platformAdmin,
  type DuplicatePlatform,
} from './support/duplicate-harness';

// Ein/Aus of the Duplikat-Erkennung (duplicate-detection design: "Ein- und Ausschalten"): the SSM
// switch, the listing commands with the detection switched off, switching it on again, and the
// Plattform_Admin's operations.

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

const AGENCY = 'agy-a';
const agent = member(AGENCY);

async function created(p: DuplicatePlatform, body: unknown): Promise<ListingView> {
  const result = await p.commands.create(agent, body);
  if (!result.ok) throw new Error(JSON.stringify(result.error));
  return result.value;
}

/** SSM fake: one parameter, every call recorded; `fail` makes reads throw. */
function fakeSsm(initial: string | undefined) {
  const state = { value: initial, fail: false, calls: [] as string[] };
  const client = {
    async send(command: unknown) {
      if (command instanceof GetParametersCommand) {
        state.calls.push('get');
        if (state.fail) throw new Error('throttled');
        const name = command.input.Names?.[0] ?? '';
        return {
          Parameters: state.value === undefined ? [] : [{ Name: name, Value: state.value }],
          InvalidParameters: state.value === undefined ? [name] : [],
        };
      }
      if (command instanceof PutParameterCommand) {
        state.calls.push(`put:${command.input.Value ?? ''}`);
        state.value = command.input.Value;
        return {};
      }
      throw new Error('unexpected command');
    },
  } as unknown as Pick<SSMClient, 'send'>;
  return { client, state };
}

describe('SsmDuplicateDetectionSetting', () => {
  const PARAMETER = '/open-estate/test/duplicate-detection';
  const setting = (initial: string | undefined, now: { t: number } = { t: 0 }) => {
    const ssm = fakeSsm(initial);
    const value = new SsmDuplicateDetectionSetting({
      client: ssm.client,
      parameterName: PARAMETER,
      clock: () => now.t,
    });
    return { ssm, value, now };
  };

  it('is on without a stored value and follows `enabled`/`disabled`', async () => {
    expect(await setting(undefined).value.isEnabled()).toBe(true);
    expect(await setting('enabled').value.isEnabled()).toBe(true);
    expect(await setting(' disabled ').value.isEnabled()).toBe(false);
  });

  it('rejects any other stored value, naming the parameter', async () => {
    await expect(setting('off').value.isEnabled()).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
      names: [PARAMETER],
    });
    expect(() => parseDuplicateDetectionMode('x', 'true')).toThrow(ConfigError);
  });

  it('reads SSM at most once per cache period; `load` always reads', async () => {
    const { ssm, value, now } = setting('enabled');
    await value.isEnabled();
    ssm.state.value = 'disabled';
    now.t = DUPLICATE_DETECTION_CACHE_TTL_MS - 1;
    expect(await value.isEnabled()).toBe(true);
    expect(await value.load()).toBe(false);
    now.t = 2 * DUPLICATE_DETECTION_CACHE_TTL_MS;
    ssm.state.value = 'enabled';
    expect(await value.isEnabled()).toBe(true);
    expect(ssm.state.calls).toEqual(['get', 'get', 'get']);
  });

  it('writes the value and sees it at once', async () => {
    const { ssm, value } = setting('enabled');
    await value.isEnabled();
    await value.setEnabled(false);
    expect(await value.isEnabled()).toBe(false);
    expect(ssm.state.calls).toEqual(['get', 'put:disabled']);
  });

  it('keeps the last value when a read fails, and fails without one', async () => {
    const { ssm, value, now } = setting('disabled');
    await value.isEnabled();
    ssm.state.fail = true;
    now.t = 2 * DUPLICATE_DETECTION_CACHE_TTL_MS;
    expect(await value.isEnabled()).toBe(false);
    await expect(setting('enabled').value.load()).resolves.toBe(true);
    const fresh = setting('enabled');
    fresh.ssm.state.fail = true;
    await expect(fresh.value.isEnabled()).rejects.toThrow('throttled');
  });
});

describe('listing commands with the Duplikat-Erkennung switched off', () => {
  it('stores a duplicate as requested, without check, flag or index entry', async () => {
    const p = duplicatePlatform({ enabled: false });
    const first = await created(p, { content: content(), status: 'ACTIVE' });
    const second = await created(p, { content: content(), status: 'ACTIVE' });

    expect(second.status).toBe('ACTIVE');
    expect(second.flags ?? []).toEqual([]);
    expect((await p.versions.get(second.id, 1))?.statusReason).toBeUndefined();
    // Nothing of the Duplikat-Erkennung is written (no cost besides the switch).
    expect(await p.index.getProfile(first.id)).toBeNull();
    expect(await p.index.getProfile(second.id)).toBeNull();
    expect(p.audit.entries.map((e) => e.action)).not.toContain('listing.flag.set');
  });

  it('keeps stored flags on changes and lets a release remove them', async () => {
    const p = duplicatePlatform();
    const first = await created(p, { content: content() });
    const second = await created(p, { content: content() });
    expect(second.flags?.[0]?.code).toBe('DUPLICATE');

    await p.detection.setEnabled(false);
    const edited = await p.commands.replaceContent(agent, second.id, {
      content: content({ title: 'Ganz andere Wohnung', rooms: 5, area: '140.00' }),
      baseVersion: second.version,
    });
    // Not checked: the stored Markierung stays, the profile is not maintained.
    expect(edited.ok && edited.value.flags?.[0]?.originalId).toBe(first.id);
    expect((await p.index.getProfile(second.id))?.listingVersion).toBe(1);

    const released = await p.commands.setStatus(agent, second.id, { status: 'ACTIVE' });
    expect(released.ok && released.value).toMatchObject({ status: 'ACTIVE', flags: [] });
    // The Verwerfung is still recorded on the stored profile (Req 8.1, 8.3).
    expect((await p.index.getProfile(second.id))?.dismissed).toEqual([first.id]);
    expect(await p.counters.get(agencyScope(AGENCY), LISTING_COUNTER_CODES.duplicateFlags)).toBe(0);
    expect(p.audit.entries.map((e) => e.action)).toContain('listing.flag.dismiss');
  });

  it('dismisses a Markierung against the Treffer it names', async () => {
    const p = duplicatePlatform();
    const first = await created(p, { content: content() });
    const second = await created(p, { content: content() });
    await p.detection.setEnabled(false);

    const dismissed = await p.commands.dismissFlag(agent, second.id, 'DUPLICATE');
    expect(dismissed.ok && dismissed.value).toMatchObject({ status: 'INACTIVE', flags: [] });
    expect((await p.index.getProfile(second.id))?.dismissed).toEqual([first.id]);
  });

  it('answers 503 and writes nothing when the switch cannot be read', async () => {
    const p = duplicatePlatform();
    p.detection.isEnabled = () => Promise.reject(new Error('ssm down'));
    const result = await p.commands.create(agent, { content: content() });
    expect(!result.ok && result.error[0]?.code).toBe('SERVICE_UNAVAILABLE');
    expect(p.listings.all()).toEqual([]);
  });

  it('catches up after switching on: the Duplikat_Abgleich indexes and flags', async () => {
    const p = duplicatePlatform({ enabled: false });
    const first = await created(p, { content: content(), status: 'ACTIVE' });
    const second = await created(p, { content: content(), status: 'ACTIVE' });

    const switched = await p.reportService.setDetection(platformAdmin, { enabled: true });
    expect(switched).toEqual({
      ok: true,
      value: { enabled: true, sweep: { executionName: 'manual-1', alreadyRunning: false } },
    });
    const summary = await p.sweep();
    expect(summary).toMatchObject({ status: 'SUCCEEDED', indexed: 2, flagsSet: 1 });
    // Flagged, but not taken offline: the Abgleich never changes a status (Req 10.3).
    const stored = await p.get(second.id);
    expect(stored?.management.status).toBe('ACTIVE');
    expect(stored?.management.flags?.[0]).toMatchObject({
      detectedBy: 'SWEEP',
      originalId: first.id,
    });
    // From now on creations are checked again.
    const third = await created(p, { content: content(), status: 'ACTIVE' });
    expect(third.status).toBe('INACTIVE');
  });
});

describe('Ein/Aus by the Plattform_Admin', () => {
  it('reads and switches the detection, audited, and restarts the index on switching on', async () => {
    const p = duplicatePlatform();
    expect(await p.reportService.getDetection(platformAdmin)).toEqual({
      ok: true,
      value: { enabled: true },
    });

    const off = await p.reportService.setDetection(platformAdmin, { enabled: false });
    expect(off).toEqual({ ok: true, value: { enabled: false } });
    expect(await p.detection.load()).toBe(false);
    expect(p.sweepStarts).toEqual([]);

    const offAgain = await p.reportService.setDetection(platformAdmin, { enabled: false });
    expect(offAgain).toEqual({ ok: true, value: { enabled: false } });

    const on = await p.reportService.setDetection(platformAdmin, { enabled: true });
    expect(on.ok && on.value.sweep?.executionName).toBe('manual-1');
    const onAgain = await p.reportService.setDetection(platformAdmin, { enabled: true });
    // Already on: nothing to rebuild.
    expect(onAgain).toEqual({ ok: true, value: { enabled: true } });
    expect(p.sweepStarts).toEqual(['manual-1']);

    expect(
      p.audit.entries
        .filter((e) => e.target === 'platform/duplicate-detection' || e.action.startsWith('dup'))
        .map((e) => [e.action, e.result]),
    ).toEqual([
      ['duplicate-detection.disable', 'SUCCESS'],
      ['duplicate-detection.disable', 'UNCHANGED'],
      ['duplicate-detection.enable', 'SUCCESS'],
      ['duplicate-sweep.start', 'SUCCESS'],
      ['duplicate-detection.enable', 'UNCHANGED'],
    ]);
  });

  it('refuses agency actors and invalid bodies', async () => {
    const p = duplicatePlatform();
    expect(await p.reportService.getDetection(agent)).toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN' },
    });
    const denied = await p.reportService.setDetection(agent, { enabled: false });
    expect(!denied.ok && denied.error[0]?.code).toBe('FORBIDDEN');
    for (const body of [undefined, {}, { enabled: 'false' }, { enabled: true, extra: 1 }]) {
      const invalid = await p.reportService.setDetection(platformAdmin, body);
      expect(!invalid.ok && invalid.error[0]?.code).toBe('INVALID_PARAMETER');
    }
    expect(await p.detection.load()).toBe(true);
  });

  it('refuses a manual Duplikat_Abgleich while switched off', async () => {
    const p = duplicatePlatform({ enabled: false });
    expect(await p.reportService.startSweep(platformAdmin)).toMatchObject({
      ok: false,
      error: { code: 'DUPLICATE_DETECTION_DISABLED' },
    });
    expect(p.sweepStarts).toEqual([]);
  });

  it('keeps the switch on when the Duplikat_Abgleich cannot be started', async () => {
    const p = duplicatePlatform({ enabled: false });
    const service = new DuplicateReportService({
      reports: p.reports,
      counters: p.counters,
      transactor: p.transactor,
      audit: p.audit,
      clock: p.clock,
      starter: { start: () => Promise.reject(new Error('states down')) },
      detection: p.detection,
    });
    expect(await service.setDetection(platformAdmin, { enabled: true })).toEqual({
      ok: true,
      value: { enabled: true },
    });
    expect(await p.detection.load()).toBe(true);
  });
});
