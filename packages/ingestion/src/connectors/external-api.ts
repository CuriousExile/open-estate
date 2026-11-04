import { z } from 'zod';
import type { Connector, ConnectorContext, ConnectorState } from '../connector';
import type { ConnectorModule } from '../registry';
import { applyFieldMapping, fieldMappingSchema, fieldPathSchema, getPath } from './field-mapping';
import { requireSecretRef, type SecretResolver } from './secrets';

export const EXTERNAL_API_MODULE = 'external-api';

/** Minimal `fetch` surface used here; the global `fetch` satisfies it. */
export type FetchLike = (
  url: string,
  init: { method: 'GET'; headers: Record<string, string>; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;
const PARAM_NAME = z.string().min(1).max(128);

const httpsUrl = z
  .url({ protocol: /^https$/, hostname: z.regexes.domain })
  .refine(
    (url) => !new URL(url).username && !new URL(url).password,
    'must not contain credentials',
  );

const paginationSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('none') }),
  z.strictObject({
    type: z.literal('cursor'),
    /** Path of the next cursor in the response; missing/empty ends the run. */
    cursorPath: fieldPathSchema,
    /** Query parameter the cursor is sent in. */
    cursorParam: PARAM_NAME,
    maxPages: z.int().min(1).max(10_000).default(1_000),
  }),
  z.strictObject({
    type: z.literal('page-number'),
    pageParam: PARAM_NAME,
    startPage: z.int().min(0).default(1),
    maxPages: z.int().min(1).max(10_000),
  }),
]);

export const externalApiSettingsSchema = z.strictObject({
  endpoint: httpsUrl,
  /** Non-secret static headers. Secrets go through `secretHeader` + `secretRef`. */
  headers: z
    .record(z.string().regex(HEADER_NAME), z.string().max(4096))
    .refine(
      (h) => !Object.keys(h).some((k) => k.toLowerCase() === 'authorization'),
      'Authorization must be configured via secretHeader',
    )
    .default({}),
  /** Header filled with the secret string of `secretRef`, e.g. `{ name: "Authorization", prefix: "Bearer " }`. */
  secretHeader: z
    .strictObject({ name: z.string().regex(HEADER_NAME), prefix: z.string().max(64).default('') })
    .optional(),
  query: z.record(PARAM_NAME, z.string().max(2048)).default({}),
  /** Path to the record array in the response body; omitted ⇒ the body itself is the array. */
  recordsPath: fieldPathSchema.optional(),
  pagination: paginationSchema.default({ type: 'none' }),
  timeoutMs: z.int().min(100).max(60_000).default(10_000),
  maxRecords: z.int().min(1).max(1_000_000).default(10_000),
  mapping: fieldMappingSchema,
});

export type ExternalApiSettings = z.output<typeof externalApiSettingsSchema>;

export interface ExternalApiDeps {
  readonly secrets: SecretResolver;
  readonly fetch?: FetchLike;
}

/** Reads paginated JSON from an https endpoint (GET only) and emits mapped records. */
export class ExternalApiConnector implements Connector<ExternalApiSettings> {
  readonly type = 'external-api' as const;
  private state: ConnectorState = 'idle';
  private headers: Record<string, string> = {};
  private readonly fetch: FetchLike;

  constructor(private readonly deps: ExternalApiDeps) {
    this.fetch = deps.fetch ?? ((url, init) => globalThis.fetch(url, init));
  }

  async initialize(ctx: ConnectorContext<ExternalApiSettings>): Promise<void> {
    const { headers, secretHeader } = ctx.config;
    this.headers = { accept: 'application/json', ...headers };
    if (secretHeader) {
      const secret = await this.deps.secrets.get(
        requireSecretRef(ctx.secretRef, EXTERNAL_API_MODULE),
      );
      this.headers[secretHeader.name] = secretHeader.prefix + secret;
    }
    this.state = 'initialized';
  }

  async run(ctx: ConnectorContext<ExternalApiSettings>): Promise<void> {
    this.state = 'running';
    try {
      await this.readAll(ctx);
      this.state = 'succeeded';
    } catch (error) {
      this.state = 'failed';
      throw error;
    }
  }

  reportStatus() {
    // Record outcomes are counted by the framework from the pipeline results.
    return { state: this.state, imported: 0, updated: 0, rejected: 0 };
  }

  private async readAll(ctx: ConnectorContext<ExternalApiSettings>): Promise<void> {
    const { pagination, maxRecords, mapping } = ctx.config;
    let emitted = 0;
    let cursor: string | undefined;
    const maxPages = pagination.type === 'none' ? 1 : pagination.maxPages;

    for (let page = 0; page < maxPages; page += 1) {
      const query: Record<string, string> = { ...ctx.config.query };
      if (pagination.type === 'page-number')
        query[pagination.pageParam] = String(pagination.startPage + page);
      if (pagination.type === 'cursor' && cursor !== undefined)
        query[pagination.cursorParam] = cursor;

      const body = await this.get(ctx.config, query);
      const records =
        ctx.config.recordsPath === undefined ? body : getPath(body, ctx.config.recordsPath);
      if (!Array.isArray(records)) throw new Error('response has no record array at recordsPath');

      for (const record of records) {
        if (emitted >= maxRecords) return;
        await ctx.emit(applyFieldMapping(record, mapping));
        emitted += 1;
      }
      if (records.length === 0) return;
      if (pagination.type === 'cursor') {
        const next = getPath(body, pagination.cursorPath);
        if (next === undefined || next === null || next === '') return;
        if (typeof next !== 'string' && typeof next !== 'number')
          throw new Error('cursor is not a string or number');
        cursor = String(next);
      }
    }
  }

  private async get(
    settings: ExternalApiSettings,
    query: Record<string, string>,
  ): Promise<unknown> {
    const url = new URL(settings.endpoint);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const response = await this.fetch(url.toString(), {
      method: 'GET',
      headers: { ...this.headers },
      signal: AbortSignal.timeout(settings.timeoutMs),
    });
    // Status only: bodies of error responses may echo request headers.
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${url.host}`);
    return response.json();
  }
}

export function externalApiModule(deps: ExternalApiDeps): ConnectorModule<ExternalApiSettings> {
  return {
    name: EXTERNAL_API_MODULE,
    type: 'external-api',
    settingsSchema: externalApiSettingsSchema,
    create: () => new ExternalApiConnector(deps),
  };
}
