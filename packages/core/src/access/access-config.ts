import { GetParametersCommand, PutParameterCommand, type SSMClient } from '@aws-sdk/client-ssm';
import { z } from 'zod';
import { ConfigError } from '../config/config-error';

/** Value ranges of Req 17.1 (also used for per-key limits, Req 17.6). */
export const RATE_LIMIT_REQUESTS_MIN = 1;
export const RATE_LIMIT_REQUESTS_MAX = 10_000;
export const RATE_LIMIT_WINDOW_SECONDS_MIN = 1;
export const RATE_LIMIT_WINDOW_SECONDS_MAX = 3_600;

export const rateLimitSchema = z.object({
  requests: z.int().min(RATE_LIMIT_REQUESTS_MIN).max(RATE_LIMIT_REQUESTS_MAX),
  windowSeconds: z.int().min(RATE_LIMIT_WINDOW_SECONDS_MIN).max(RATE_LIMIT_WINDOW_SECONDS_MAX),
});

export type RateLimit = z.infer<typeof rateLimitSchema>;

export const DEFAULT_RATE_LIMIT: RateLimit = { requests: 60, windowSeconds: 60 };

/** `open`: clients are identified by source IP; `api-keys`: a valid API key is required. */
export const ACCESS_MODES = ['open', 'api-keys'] as const;
export type AccessMode = (typeof ACCESS_MODES)[number];
export const DEFAULT_ACCESS_MODE: AccessMode = 'open';

export interface AccessConfig {
  mode: AccessMode;
  /** Global limit; per-key limits override it (Req 17.6). */
  rateLimit: RateLimit;
}

/** Source of the global access configuration. The AccessGuard caches it for 60 s. */
export interface AccessConfigSource {
  load(): Promise<AccessConfig>;
}

/**
 * Write side used by the Admin-API (Req 17.8, 17.9). Callers validate with `rateLimitSchema`
 * first; implementations write exactly the format {@link AccessConfigSource} reads.
 */
export interface AccessConfigWriter {
  setRateLimit(rateLimit: RateLimit): Promise<void>;
  setAccessMode(mode: AccessMode): Promise<void>;
}

/** Fake/fixed source for tests and local runs; `set` and the writer methods simulate admin changes. */
export class StaticAccessConfigSource implements AccessConfigSource, AccessConfigWriter {
  constructor(private config: AccessConfig) {}

  set(config: AccessConfig): void {
    this.config = config;
  }

  async setRateLimit(rateLimit: RateLimit): Promise<void> {
    this.config = { ...this.config, rateLimit: { ...rateLimit } };
  }

  async setAccessMode(mode: AccessMode): Promise<void> {
    this.config = { ...this.config, mode };
  }

  async load(): Promise<AccessConfig> {
    return this.config;
  }
}

export interface SsmAccessConfigSourceOptions {
  client: SSMClient;
  /** Parameter holding `open` | `api-keys`, e.g. `/open-estate/{env}/access-mode`. */
  accessModeParameter: string;
  /** Parameter holding `{"requests":N,"windowSeconds":W}`, e.g. `/open-estate/{env}/rate-limit`. */
  rateLimitParameter: string;
}

/**
 * Reads access mode and global rate limit from SSM in one `GetParameters` call.
 * A missing parameter falls back to the documented default (`open`, 60 per 60 s);
 * an invalid value throws `ConfigError{code:"CONFIG_INVALID"}` instead of guessing.
 */
export class SsmAccessConfigSource implements AccessConfigSource {
  constructor(private readonly options: SsmAccessConfigSourceOptions) {}

  async load(): Promise<AccessConfig> {
    const { client, accessModeParameter, rateLimitParameter } = this.options;
    const out = await client.send(
      new GetParametersCommand({ Names: [accessModeParameter, rateLimitParameter] }),
    );
    const values = new Map<string, string>();
    for (const { Name, Value } of out.Parameters ?? []) {
      if (Name !== undefined && Value !== undefined && Value.trim() !== '') {
        values.set(Name, Value.trim());
      }
    }

    const rawMode = values.get(accessModeParameter);
    const rawLimit = values.get(rateLimitParameter);
    return {
      mode: rawMode === undefined ? DEFAULT_ACCESS_MODE : parseMode(accessModeParameter, rawMode),
      rateLimit:
        rawLimit === undefined ? DEFAULT_RATE_LIMIT : parseRateLimit(rateLimitParameter, rawLimit),
    };
  }
}

/**
 * Overwrites the parameters read by {@link SsmAccessConfigSource}: the mode as plain string,
 * the rate limit as `{"requests":N,"windowSeconds":W}`. The value is re-validated, so an
 * out-of-range limit is never written.
 */
export class SsmAccessConfigWriter implements AccessConfigWriter {
  constructor(private readonly options: SsmAccessConfigSourceOptions) {}

  async setRateLimit(rateLimit: RateLimit): Promise<void> {
    const { requests, windowSeconds } = rateLimitSchema.parse(rateLimit);
    await this.put(this.options.rateLimitParameter, JSON.stringify({ requests, windowSeconds }));
  }

  async setAccessMode(mode: AccessMode): Promise<void> {
    await this.put(
      this.options.accessModeParameter,
      parseMode(this.options.accessModeParameter, mode),
    );
  }

  private async put(Name: string, Value: string): Promise<void> {
    await this.options.client.send(
      new PutParameterCommand({ Name, Value, Type: 'String', Overwrite: true }),
    );
  }
}

function parseMode(parameter: string, raw: string): AccessMode {
  const mode = ACCESS_MODES.find((m) => m === raw);
  if (mode === undefined) {
    throw new ConfigError(
      'CONFIG_INVALID',
      [parameter],
      [{ path: '', message: `expected one of ${ACCESS_MODES.join(', ')}` }],
    );
  }
  return mode;
}

function parseRateLimit(parameter: string, raw: string): RateLimit {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigError('CONFIG_INVALID', [parameter], [{ path: '', message }]);
  }
  const result = rateLimitSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigError(
      'CONFIG_INVALID',
      [parameter],
      result.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message,
      })),
    );
  }
  return result.data;
}
