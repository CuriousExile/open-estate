import { ConfigError, loadConfig, type ConfigSources } from '@open-estate/core';

// Configuration of the management Lambda. Table and parameter names come from the environment
// (set by the ManagementStack); nothing environment-specific lives in the code (Req 11.1 of
// `real-estate-platform`).

/** Environment variables of the access path (Authenticator, AccessGuard, Audit_Log). */
export const MANAGEMENT_ENV = {
  userPoolId: 'USER_POOL_ID',
  /** App client of the Agentur_Portal; access tokens of other clients are rejected. */
  userPoolClientId: 'USER_POOL_CLIENT_ID',
  membershipsTable: 'MEMBERSHIPS_TABLE_NAME',
  agenciesTable: 'AGENCIES_TABLE_NAME',
  machineAccessTable: 'MACHINE_ACCESS_TABLE_NAME',
  auditLogTable: 'AUDIT_LOG_TABLE_NAME',
  rateLimitCountersTable: 'RATE_LIMIT_COUNTERS_TABLE_NAME',
  /** `/open-estate/{env}/management-rate-limit`. */
  rateLimitParameter: 'MANAGEMENT_RATE_LIMIT_PARAMETER_NAME',
} as const;

export type ManagementEnv = Record<keyof typeof MANAGEMENT_ENV, string>;

/**
 * Reads every variable of `spec` (logical key → variable name). Throws one
 * `ConfigError{CONFIG_MISSING}` naming every missing or empty variable. Route groups use it for
 * their own variables.
 */
export function readEnv<K extends string>(
  env: Readonly<Record<string, string | undefined>>,
  spec: Readonly<Record<K, string>>,
): Record<K, string> {
  const values = {} as Record<K, string>;
  const missing: string[] = [];
  for (const key of Object.keys(spec) as K[]) {
    const name = spec[key];
    const value = env[name]?.trim();
    if (value === undefined || value === '') missing.push(name);
    else values[key] = value;
  }
  if (missing.length > 0) throw new ConfigError('CONFIG_MISSING', missing);
  return values;
}

export const readManagementEnv = (env: Readonly<Record<string, string | undefined>>) =>
  readEnv(env, MANAGEMENT_ENV);

/**
 * Logical config value of the frontend origin, resolved by the ConfigProvider:
 * `FRONTEND_ORIGIN` or the SSM parameter named by `FRONTEND_ORIGIN_SSM_PARAMETER`
 * (`/open-estate/{env}/frontend-origin`, written by the FrontendStack).
 */
export const FRONTEND_ORIGIN_VALUE = 'FRONTEND_ORIGIN';

// `scheme://host[:port]`: no path (not even `/`), query, fragment or userinfo.
const ORIGIN_PATTERN = /^https?:\/\/[^/?#@\s]+$/i;
const SERIALIZED_ORIGIN = /^https?:\/\/[a-z0-9.-]+(:\d+)?$/;

/** Serialized `http(s)` origin (lower-case, default port dropped) or `undefined`. */
export function normalizeOrigin(value: string): string | undefined {
  const raw = value.trim();
  if (!ORIGIN_PATTERN.test(raw)) return undefined;
  try {
    const { origin } = new URL(raw);
    return SERIALIZED_ORIGIN.test(origin) ? origin : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Loads the frontend origin at init (Req 4.5). Unlike the Search_API's CORS list it is
 * mandatory: without it a `MANUAL` listing would get no Quell-URL, so a missing value throws
 * `ConfigError{CONFIG_MISSING}` and an invalid one `ConfigError{CONFIG_INVALID}` (naming the
 * value, never its content); AWS errors propagate.
 */
export async function loadFrontendOrigin(
  env: Readonly<Record<string, string | undefined>>,
  sources: Omit<ConfigSources, 'env'> = {},
): Promise<string> {
  const config = await loadConfig({ values: [FRONTEND_ORIGIN_VALUE] }, { ...sources, env });
  const raw = config.requireAll([FRONTEND_ORIGIN_VALUE])[FRONTEND_ORIGIN_VALUE] ?? '';
  const origin = normalizeOrigin(raw);
  if (origin === undefined) {
    throw new ConfigError(
      'CONFIG_INVALID',
      [FRONTEND_ORIGIN_VALUE],
      // config-check-ignore: format placeholder in an error message, not an endpoint
      [{ path: '', message: 'expected https://host[:port]' }],
    );
  }
  return origin;
}
