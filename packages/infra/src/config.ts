import * as path from 'node:path';
import { RemovalPolicy } from 'aws-cdk-lib';
import { PriceClass } from 'aws-cdk-lib/aws-cloudfront';
import {
  ACCESS_MODES,
  DEFAULT_ACCESS_MODE,
  DEFAULT_RATE_LIMIT,
  rateLimitSchema,
  type AccessMode,
  type RateLimit,
} from '@open-estate/core';
import { parseOriginList } from '@open-estate/api';
import { Currency } from '@open-estate/shared';

/** CDK context key selecting the target environment: `cdk synth -c env=prod`. */
export const ENV_CONTEXT_KEY = 'env';
export const DEFAULT_ENV_NAME = 'dev';

// Used as stack-name prefix and API stage name, so keep it short and URL/CloudFormation safe.
const ENV_NAME_PATTERN = /^[a-z][a-z0-9-]{0,15}$/;

export interface EnvironmentConfig {
  /** Environment name, e.g. `dev` or `prod`. */
  readonly envName: string;
  /** Prefix for all stack names, e.g. `OpenEstate-dev`. */
  readonly stackPrefix: string;
  /** API Gateway stage name. */
  readonly stageName: string;
  /** Only `dev` is disposable; every other environment keeps its data when a stack is deleted. */
  readonly removalPolicy: RemovalPolicy;
}

/** Resolves the environment config from the `env` context value; fails synth on an invalid name. */
export function resolveEnvironment(rawEnvName: unknown): EnvironmentConfig {
  const envName = rawEnvName === undefined ? DEFAULT_ENV_NAME : rawEnvName;
  if (typeof envName !== 'string' || !ENV_NAME_PATTERN.test(envName)) {
    throw new Error(
      `Invalid context value "${ENV_CONTEXT_KEY}": ${JSON.stringify(envName)} (expected ${ENV_NAME_PATTERN.source})`,
    );
  }
  return {
    envName,
    stackPrefix: `OpenEstate-${envName}`,
    stageName: envName,
    removalPolicy: envName === DEFAULT_ENV_NAME ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN,
  };
}

// Same relative depth from `src/` (ts) and `dist/` (compiled js).
const REPO_ROOT = path.resolve(__dirname, '../../..');

/** Configuration files shipped with the repository (`taxonomy.json`, `tour-providers.json`, Req 15.2). */
export const DEFAULT_CONFIG_DIR = path.join(REPO_ROOT, 'packages/shared/src/config');

/**
 * The frontend's `i18n-config.json`, mirrored into the config bucket so API/MCP and frontend share
 * one list of enabled locales (design: "Konfigurationsmodelle").
 */
export const DEFAULT_I18N_CONFIG_FILE = path.join(
  REPO_ROOT,
  'packages/frontend/public/i18n-config.json',
);

/**
 * Angular build output (`angular.json` `outputPath` + `/browser`), uploaded by the FrontendStack.
 * Produced by `npm run build`; `cdk synth` fails with a hint if it is missing.
 */
export const DEFAULT_FRONTEND_ASSET_DIR = path.join(REPO_ROOT, 'packages/frontend/dist/browser');

/** WAF rate-based rules count per IP over a fixed window of 60, 120, 300 or 600 s. */
export const WAF_RATE_LIMIT_WINDOW_SECONDS = 300;
// AWS WAF bounds of `RateBasedStatement.Limit`.
const WAF_RATE_LIMIT_MIN = 10;
const WAF_RATE_LIMIT_MAX = 2_000_000_000;

export const SEARCH_PROVIDERS = ['dynamodb', 'opensearch'] as const;
export type SearchProviderKind = (typeof SEARCH_PROVIDERS)[number];

/**
 * Log levels accepted by the AWS Lambda Powertools Logger (`POWERTOOLS_LOG_LEVEL`). `SILENT`
 * suppresses application log lines; it does not stop the Lambda runtime's START/END/REPORT lines
 * nor the EMF metric lines (those are controlled by {@link ObservabilitySettings.metricsDisabled}).
 */
export const LOG_LEVELS = ['DEBUG', 'INFO', 'WARN', 'ERROR', 'CRITICAL', 'SILENT'] as const;
export type LogLevelName = (typeof LOG_LEVELS)[number];

/** Powertools environment variable names set on every runtime function. */
export const POWERTOOLS_LOG_LEVEL_ENV = 'POWERTOOLS_LOG_LEVEL';
export const POWERTOOLS_METRICS_DISABLED_ENV = 'POWERTOOLS_METRICS_DISABLED';

/**
 * Logging and metrics knobs applied to every runtime Lambda (API, MCP, admin, connectors). They
 * let a quiet dev/demo deployment cut CloudWatch cost without touching code: raise the level to
 * drop application log lines, and/or disable EMF metrics. Disabling metrics also removes the data
 * behind the latency alarms and dashboard, so keep it on for environments you monitor.
 */
export interface ObservabilitySettings {
  /** Powertools log level; application lines below it are dropped. Default `INFO`. */
  readonly logLevel: LogLevelName;
  /** `true` suppresses EMF metric output (the per-request `RequestLatency` line). Default `false`. */
  readonly metricsDisabled: boolean;
}

export const DEFAULT_OBSERVABILITY_SETTINGS: ObservabilitySettings = {
  logLevel: 'INFO',
  metricsDisabled: false,
};

/**
 * Initial values of the SSM parameters, the files uploaded to the config bucket and the WAF limit.
 * Each value can be overridden per deployment via CDK context, e.g. `-c defaultCurrency=THB`.
 */
export interface PlatformSettings {
  readonly defaultCurrency: string;
  readonly accessMode: AccessMode;
  readonly rateLimit: RateLimit;
  readonly searchProvider: SearchProviderKind;
  /** Absolute path of the directory whose files are validated and uploaded to the config bucket. */
  readonly configDir: string;
  /** Absolute path of the `i18n-config.json` mirrored into the config bucket. */
  readonly i18nConfigFile: string;
  /**
   * Static per-IP flood limit of the WAF in front of the API (requests per
   * {@link WAF_RATE_LIMIT_WINDOW_SECONDS}); coarse protection, not the Req 17 rate limit.
   */
  readonly wafRateLimit: number;
  /** Absolute path of the built SPA (contains `index.html`). */
  readonly frontendAssetDir: string;
  /** CloudFront edge locations of the frontend; `PriceClass_100` keeps costs lowest. */
  readonly frontendPriceClass: PriceClass;
  /**
   * Browser origins allowed by the Search_API in addition to the CloudFront origin of the
   * FrontendStack (e.g. a custom domain or `http://localhost:4200`); normalized, no `*`.
   */
  readonly corsAllowedOrigins: readonly string[];
  /** Logging and metrics knobs applied to every runtime Lambda; see {@link ObservabilitySettings}. */
  readonly observability: ObservabilitySettings;
}

export const DEFAULT_PLATFORM_SETTINGS: PlatformSettings = {
  defaultCurrency: 'EUR',
  accessMode: DEFAULT_ACCESS_MODE,
  rateLimit: DEFAULT_RATE_LIMIT,
  searchProvider: 'dynamodb',
  configDir: DEFAULT_CONFIG_DIR,
  i18nConfigFile: DEFAULT_I18N_CONFIG_FILE,
  wafRateLimit: 2_000,
  frontendAssetDir: DEFAULT_FRONTEND_ASSET_DIR,
  frontendPriceClass: PriceClass.PRICE_CLASS_100,
  corsAllowedOrigins: [],
  observability: DEFAULT_OBSERVABILITY_SETTINGS,
};

/** CDK context keys overriding {@link DEFAULT_PLATFORM_SETTINGS}. */
export const SETTINGS_CONTEXT_KEYS = {
  defaultCurrency: 'defaultCurrency',
  accessMode: 'accessMode',
  /** JSON in the format of the SSM parameter: `{"requests":N,"windowSeconds":W}`. */
  rateLimit: 'rateLimit',
  searchProvider: 'searchProvider',
  /** Relative paths resolve against the current working directory. */
  configDir: 'configDir',
  i18nConfigFile: 'i18nConfigFile',
  /** Requests per IP and 5 minutes, e.g. `-c wafRateLimit=5000`. */
  wafRateLimit: 'wafRateLimit',
  /** E.g. `-c frontendAssetDir=packages/frontend/dist/browser`. */
  frontendAssetDir: 'frontendAssetDir',
  /** `PriceClass_100`, `PriceClass_200` or `PriceClass_All`. */
  frontendPriceClass: 'frontendPriceClass',
  /** Comma-separated origins, e.g. `-c corsAllowedOrigins=http://localhost:4200`. */
  corsAllowedOrigins: 'corsAllowedOrigins',
  /** Powertools log level, e.g. `-c logLevel=WARN` (DEBUG, INFO, WARN, ERROR, CRITICAL, SILENT). */
  logLevel: 'logLevel',
  /** `-c metricsDisabled=true` suppresses the per-request EMF metric line. */
  metricsDisabled: 'metricsDisabled',
} as const;

// Codes known to the ICU data of the running Node.js; the shared schema only checks the format.
const ISO_4217_CODES = new Set(Intl.supportedValuesOf('currency'));

type Parsed<T> = { ok: true; value: T } | { ok: false; expected: string };

function parseCurrency(raw: string): Parsed<string> {
  return Currency.safeParse(raw).success && ISO_4217_CODES.has(raw)
    ? { ok: true, value: raw }
    : { ok: false, expected: 'an ISO 4217 currency code, e.g. EUR' };
}

function parseEnum<T extends string>(values: readonly T[]) {
  return (raw: string): Parsed<T> => {
    const value = values.find((v) => v === raw);
    return value === undefined
      ? { ok: false, expected: `one of ${values.join(', ')}` }
      : { ok: true, value };
  };
}

function parseRateLimit(raw: string): Parsed<RateLimit> {
  const expected = 'JSON {"requests":1..10000,"windowSeconds":1..3600}';
  try {
    const result = rateLimitSchema.safeParse(JSON.parse(raw));
    return result.success ? { ok: true, value: result.data } : { ok: false, expected };
  } catch {
    return { ok: false, expected };
  }
}

const parsePath =
  (expected: string) =>
  (raw: string): Parsed<string> =>
    raw.trim() === '' ? { ok: false, expected } : { ok: true, value: path.resolve(raw) };

function parseWafRateLimit(raw: string): Parsed<number> {
  const value = Number(raw);
  return /^\d+$/.test(raw.trim()) && value >= WAF_RATE_LIMIT_MIN && value <= WAF_RATE_LIMIT_MAX
    ? { ok: true, value }
    : { ok: false, expected: `an integer ${WAF_RATE_LIMIT_MIN}..${WAF_RATE_LIMIT_MAX}` };
}

function parseBoolean(raw: string): Parsed<boolean> {
  const value = raw.trim().toLowerCase();
  if (value === 'true') return { ok: true, value: true };
  if (value === 'false') return { ok: true, value: false };
  return { ok: false, expected: 'true or false' };
}

function parseOrigins(raw: string): Parsed<readonly string[]> {
  // cdk.json may hold a JSON array; `-c` yields a comma-separated string.
  let text = raw;
  try {
    const json: unknown = JSON.parse(raw);
    if (Array.isArray(json) && json.every((v) => typeof v === 'string')) text = json.join(',');
  } catch {
    // not JSON: comma-separated list
  }
  const { origins, invalid } = parseOriginList(text);
  return invalid.length === 0
    ? { ok: true, value: origins }
    : { ok: false, expected: 'comma-separated origins like https://example.com (no path, no *)' };
}

/**
 * Resolves the platform settings from CDK context (`tryGetContext`). Every invalid value is
 * reported in one error, so synth fails with a complete list instead of one problem at a time.
 */
export function resolvePlatformSettings(getContext: (key: string) => unknown): PlatformSettings {
  const errors: string[] = [];
  function pick<T>(key: string, parse: (raw: string) => Parsed<T>, fallback: T): T {
    const raw = getContext(key);
    if (raw === undefined) return fallback;
    // `-c key=value` always yields strings; cdk.json may hold objects (e.g. rateLimit).
    const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
    const parsed = parse(text);
    if (parsed.ok) return parsed.value;
    errors.push(`"${key}": ${JSON.stringify(raw)} (expected ${parsed.expected})`);
    return fallback;
  }

  const keys = SETTINGS_CONTEXT_KEYS;
  const defaults = DEFAULT_PLATFORM_SETTINGS;
  const settings: PlatformSettings = {
    defaultCurrency: pick(keys.defaultCurrency, parseCurrency, defaults.defaultCurrency),
    accessMode: pick(keys.accessMode, parseEnum(ACCESS_MODES), defaults.accessMode),
    rateLimit: pick(keys.rateLimit, parseRateLimit, defaults.rateLimit),
    searchProvider: pick(keys.searchProvider, parseEnum(SEARCH_PROVIDERS), defaults.searchProvider),
    configDir: pick(keys.configDir, parsePath('a directory path'), defaults.configDir),
    i18nConfigFile: pick(keys.i18nConfigFile, parsePath('a file path'), defaults.i18nConfigFile),
    wafRateLimit: pick(keys.wafRateLimit, parseWafRateLimit, defaults.wafRateLimit),
    frontendAssetDir: pick(
      keys.frontendAssetDir,
      parsePath('a directory path'),
      defaults.frontendAssetDir,
    ),
    frontendPriceClass: pick(
      keys.frontendPriceClass,
      parseEnum(Object.values(PriceClass)),
      defaults.frontendPriceClass,
    ),
    corsAllowedOrigins: pick(keys.corsAllowedOrigins, parseOrigins, defaults.corsAllowedOrigins),
    observability: {
      logLevel: pick(keys.logLevel, parseEnum(LOG_LEVELS), defaults.observability.logLevel),
      metricsDisabled: pick(
        keys.metricsDisabled,
        parseBoolean,
        defaults.observability.metricsDisabled,
      ),
    },
  };
  if (errors.length > 0) {
    throw new Error(`Invalid context value(s):\n  - ${errors.join('\n  - ')}`);
  }
  return settings;
}
