import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { I18nConfig } from '@open-estate/core';
import {
  assertValidTaxonomy,
  ExchangeRatesConfig,
  PiiAllowlistConfig,
  TaxonomyConfig,
  TourProvidersConfig,
  type LocaleConfig,
  type Taxonomy,
} from '@open-estate/shared';
import type { ZodType } from 'zod';

// DEV ONLY: configuration of the local demo. The content rules come from the repository's
// default config files (the ones the CDK app uploads to the config bucket); network settings
// from environment variables with loopback defaults.

/** Repository root: this file lives in `packages/devserver/{src,dist}/`. */
export const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

/** Default config files of the repository (what `cdk deploy` uploads without overrides). */
export const DEFAULT_CONFIG_FILES = {
  taxonomy: 'packages/shared/src/config/taxonomy.json',
  tourProviders: 'packages/shared/src/config/tour-providers.json',
  exchangeRates: 'packages/shared/src/config/exchange-rates.json',
  piiAllowlist: 'packages/shared/src/config/pii-allowlist.json',
  i18n: 'packages/frontend/public/i18n-config.json',
} as const;

export interface ContentConfig {
  taxonomy: Taxonomy;
  locales: LocaleConfig;
  tourProviders: TourProvidersConfig;
  /** Static demo exchange rates (EUR base; THB, USD, GBP, CHF). */
  exchangeRates: ExchangeRatesConfig;
  piiAllowlist: PiiAllowlistConfig;
  defaultCurrency: string;
}

function readJson<T>(root: string, file: string, schema: ZodType<T>): T {
  const parsed = schema.safeParse(JSON.parse(readFileSync(path.join(root, file), 'utf8')));
  if (!parsed.success) {
    throw new Error(`${file}: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`);
  }
  return parsed.data;
}

/** Loads and validates the default config files; throws naming the invalid file. */
export function loadContentConfig(root: string = REPO_ROOT): ContentConfig {
  const files = DEFAULT_CONFIG_FILES;
  return {
    taxonomy: assertValidTaxonomy(readJson(root, files.taxonomy, TaxonomyConfig)),
    locales: readJson(root, files.i18n, I18nConfig),
    tourProviders: readJson(root, files.tourProviders, TourProvidersConfig),
    exchangeRates: readJson(root, files.exchangeRates, ExchangeRatesConfig),
    piiAllowlist: readJson(root, files.piiAllowlist, PiiAllowlistConfig),
    defaultCurrency: 'EUR',
  };
}

export interface NetworkConfig {
  /** Interface the server binds to; loopback only. */
  host: string;
  port: number;
  /** Port of the SPA's dev server (`ng serve`). */
  frontendPort: number;
  /** Origin of the SPA (`ng serve`), used for public detail URLs and allowed redirects. */
  frontendOrigin: string;
  /** Public base URL of this server as the browser reaches it. */
  publicUrl: string;
}

/** Default ports of the local demo: dev server (APIs) and SPA (`ng serve`). */
export const DEFAULT_PORTS = { api: 4310, frontend: 4200 } as const;

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

function readPort(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
): number {
  const raw = env[name]?.trim() || String(fallback);
  const port = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name}=${env[name] ?? ''}: expected a TCP port (1-65535)`);
  }
  return port;
}

function isHttpUrl(value: string): boolean {
  try {
    return /^https?:$/.test(new URL(value).protocol);
  } catch {
    return false;
  }
}

/**
 * `DEV_HOST`, `DEV_PORT`, `DEV_FRONTEND_PORT`, `DEV_FRONTEND_ORIGIN`; refuses non-loopback hosts.
 * The SPA origin defaults to `http://127.0.0.1:<DEV_FRONTEND_PORT>`; set `DEV_FRONTEND_ORIGIN`
 * only if the browser reaches the SPA under another origin.
 */
export function readNetworkConfig(
  env: Readonly<Record<string, string | undefined>>,
): NetworkConfig {
  const host = env['DEV_HOST']?.trim() || '127.0.0.1';
  if (!LOOPBACK.has(host)) {
    throw new Error(`DEV_HOST=${host}: the insecure dev server only binds to a loopback address`);
  }
  const port = readPort(env, 'DEV_PORT', DEFAULT_PORTS.api);
  const frontendPort = readPort(env, 'DEV_FRONTEND_PORT', DEFAULT_PORTS.frontend);
  const frontendOrigin = (
    env['DEV_FRONTEND_ORIGIN']?.trim() || `http://127.0.0.1:${frontendPort}`
  ).replace(/\/+$/, '');
  if (!isHttpUrl(frontendOrigin)) {
    throw new Error(`DEV_FRONTEND_ORIGIN=${frontendOrigin}: expected an http(s) origin`);
  }
  const urlHost = host === '::1' ? '[::1]' : host;
  return { host, port, frontendPort, frontendOrigin, publicUrl: `http://${urlHost}:${port}` };
}

/**
 * Clock shared by every service. Seeding runs with simulated past timestamps so versions,
 * runs, counters and the audit log spread over the last weeks; afterwards the clock is real time.
 */
export class DemoClock {
  private simulated: number | undefined;

  readonly now = (): number => this.simulated ?? Date.now();

  /** Freezes time at `ms` (seeding). */
  set(ms: number): void {
    this.simulated = ms;
  }

  /** Back to real time. */
  release(): void {
    this.simulated = undefined;
  }
}
