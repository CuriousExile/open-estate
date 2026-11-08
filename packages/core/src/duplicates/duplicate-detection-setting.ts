import { GetParametersCommand, PutParameterCommand, type SSMClient } from '@aws-sdk/client-ssm';
import { ConfigError } from '../config/config-error';
import { systemClock, type Clock } from '../access/ttl-cache';

// Ein/Aus der Duplikat-Erkennung (duplicate-detection design: "Ein- und Ausschalten"): one value
// for the whole platform. The initial value comes from the deployment (CDK context
// `duplicateDetection`), a Plattform_Admin switches it at runtime (`PUT
// /platform/duplicate-detection`). Switched off, no write runs a Duplikat_Prüfung or maintains the
// Duplikat_Index and the daily Duplikat_Abgleich ends right after its start, so the feature costs
// nothing but this parameter read. Stored Markierungen and Treffer stay and can still be released.

/**
 * Environment variable naming the SSM parameter `/open-estate/<env>/duplicate-detection`; set on
 * the Management_API, the connectors and the Duplikat_Abgleich.
 */
export const DUPLICATE_DETECTION_PARAMETER_ENV = 'DUPLICATE_DETECTION_PARAMETER_NAME';

/** Values of the SSM parameter `/open-estate/<env>/duplicate-detection`. */
export const DUPLICATE_DETECTION_MODES = ['enabled', 'disabled'] as const;
export type DuplicateDetectionMode = (typeof DUPLICATE_DETECTION_MODES)[number];

/** Without a stored value the detection runs (the behaviour before the switch existed). */
export const DEFAULT_DUPLICATE_DETECTION_MODE: DuplicateDetectionMode = 'enabled';

/** A change reaches every running function within this time (like the access mode, Req 17.9). */
export const DUPLICATE_DETECTION_CACHE_TTL_MS = 60_000;

/** Read side used by the write paths and the Duplikat_Abgleich. */
export interface DuplicateDetectionSwitch {
  /** Current value, cached for at most {@link DUPLICATE_DETECTION_CACHE_TTL_MS}. */
  isEnabled(): Promise<boolean>;
}

/** Read and write side of the Plattform_Admin's switch. */
export interface DuplicateDetectionSetting extends DuplicateDetectionSwitch {
  /** The stored value, bypassing the cache (start of a Duplikat_Abgleich, switching). */
  load(): Promise<boolean>;
  /** Stores the value; this instance sees it immediately, others within the cache time. */
  setEnabled(enabled: boolean): Promise<void>;
}

export const duplicateDetectionMode = (enabled: boolean): DuplicateDetectionMode =>
  enabled ? 'enabled' : 'disabled';

/** Parses a stored value; anything but `enabled`/`disabled` is `CONFIG_INVALID`. */
export function parseDuplicateDetectionMode(name: string, raw: string): DuplicateDetectionMode {
  const mode = DUPLICATE_DETECTION_MODES.find((m) => m === raw.trim());
  if (mode === undefined) {
    throw new ConfigError(
      'CONFIG_INVALID',
      [name],
      [{ path: '', message: `expected one of ${DUPLICATE_DETECTION_MODES.join(', ')}` }],
    );
  }
  return mode;
}

/** Fixed value for tests, the dev server and wirings without a parameter. */
export class StaticDuplicateDetectionSetting implements DuplicateDetectionSetting {
  private enabled: boolean;

  constructor(enabled = true) {
    this.enabled = enabled;
  }

  async isEnabled(): Promise<boolean> {
    return this.enabled;
  }

  async load(): Promise<boolean> {
    return this.enabled;
  }

  async setEnabled(enabled: boolean): Promise<void> {
    this.enabled = enabled;
  }
}

export interface SsmDuplicateDetectionSettingOptions {
  client: Pick<SSMClient, 'send'>;
  /** `/open-estate/<env>/duplicate-detection`. */
  parameterName: string;
  clock?: Clock;
  ttlMs?: number;
}

/**
 * The switch on its SSM parameter. A missing parameter means {@link
 * DEFAULT_DUPLICATE_DETECTION_MODE}; an invalid value throws `ConfigError{CONFIG_INVALID}`. A failed
 * read falls back to the last value read (and tries again with the next call); without one it
 * throws, and the callers answer like an unreachable Duplikat_Index (nothing is written unchecked).
 */
export class SsmDuplicateDetectionSetting implements DuplicateDetectionSetting {
  private readonly options: SsmDuplicateDetectionSettingOptions;
  private cached: { enabled: boolean; loadedAt: number } | undefined;

  constructor(options: SsmDuplicateDetectionSettingOptions) {
    this.options = options;
  }

  private get clock(): Clock {
    return this.options.clock ?? systemClock;
  }

  async isEnabled(): Promise<boolean> {
    const ttl = this.options.ttlMs ?? DUPLICATE_DETECTION_CACHE_TTL_MS;
    const cached = this.cached;
    if (cached !== undefined && this.clock() - cached.loadedAt < ttl) return cached.enabled;
    try {
      return await this.load();
    } catch (error) {
      if (cached !== undefined && !(error instanceof ConfigError)) return cached.enabled;
      throw error;
    }
  }

  async load(): Promise<boolean> {
    const { client, parameterName } = this.options;
    const out = await client.send(new GetParametersCommand({ Names: [parameterName] }));
    const raw = out.Parameters?.find((p) => p.Name === parameterName)?.Value;
    const mode =
      raw === undefined || raw.trim() === ''
        ? DEFAULT_DUPLICATE_DETECTION_MODE
        : parseDuplicateDetectionMode(parameterName, raw);
    return this.remember(mode === 'enabled');
  }

  async setEnabled(enabled: boolean): Promise<void> {
    await this.options.client.send(
      new PutParameterCommand({
        Name: this.options.parameterName,
        Value: duplicateDetectionMode(enabled),
        Type: 'String',
        Overwrite: true,
      }),
    );
    this.remember(enabled);
  }

  private remember(enabled: boolean): boolean {
    this.cached = { enabled, loadedAt: this.clock() };
    return enabled;
  }
}
