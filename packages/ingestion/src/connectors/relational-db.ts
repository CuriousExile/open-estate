import { Client } from 'pg';
import { z } from 'zod';
import type { Connector, ConnectorContext, ConnectorState } from '../connector';
import type { ConnectorModule } from '../registry';
import { applyFieldMapping, fieldMappingSchema } from './field-mapping';
import { requireSecretRef, type SecretResolver } from './secrets';

export const RELATIONAL_DB_MODULE = 'relational-db';

/**
 * MVP supports PostgreSQL only (via `pg`): it is the open-source default on RDS/Aurora,
 * `pg` is pure JS (no native build in Lambda) and supports parameterised queries and
 * read-only transactions. MySQL can follow as another module with the same settings shape.
 */
export const SUPPORTED_ENGINES = ['postgres'] as const;

/** Connection data as stored by RDS-managed secrets (`engine`, `host`, `port`, `username`, `password`, `dbname`). */
const rdsSecretSchema = z.object({
  engine: z.enum(SUPPORTED_ENGINES).optional(),
  host: z.string().min(1),
  port: z.coerce.number().int().min(1).max(65_535).default(5432),
  username: z.string().min(1),
  password: z.string().min(1),
  dbname: z.string().min(1),
});

export type DbCredentials = z.output<typeof rdsSecretSchema>;

/** Starts with SELECT/WITH and is a single statement (no `;` except one trailing). */
const READ_QUERY = /^\s*(select|with)\b[^;]*;?\s*$/is;

export const relationalDbSettingsSchema = z.strictObject({
  /**
   * Constant SELECT from configuration; values go into `parameters` ($1, $2, …), never into
   * the string. Use a read-only database user. Needs a deterministic ORDER BY, since rows
   * are read in LIMIT/OFFSET batches.
   */
  query: z.string().max(10_000).regex(READ_QUERY, 'must be a single SELECT or WITH statement'),
  parameters: z
    .array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
    .max(100)
    .default([]),
  batchSize: z.int().min(1).max(10_000).default(500),
  maxRecords: z.int().min(1).max(1_000_000).default(100_000),
  /** TLS with certificate verification; trust the RDS CA via `NODE_EXTRA_CA_CERTS`. */
  tls: z.boolean().default(true),
  connectTimeoutMs: z.int().min(100).max(60_000).default(10_000),
  statementTimeoutMs: z.int().min(100).max(900_000).default(60_000),
  mapping: fieldMappingSchema,
});

export type RelationalDbSettings = z.output<typeof relationalDbSettingsSchema>;

/** The part of `pg.Client` used here. */
export interface DbClient {
  connect(): Promise<unknown>;
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
  end(): Promise<void>;
}

export interface DbClientOptions {
  readonly credentials: DbCredentials;
  readonly tls: boolean;
  readonly connectTimeoutMs: number;
  readonly statementTimeoutMs: number;
}

export type DbClientFactory = (options: DbClientOptions) => DbClient;

export const pgClientFactory: DbClientFactory = ({
  credentials,
  tls,
  connectTimeoutMs,
  statementTimeoutMs,
}) =>
  new Client({
    host: credentials.host,
    port: credentials.port,
    user: credentials.username,
    password: credentials.password,
    database: credentials.dbname,
    ssl: tls ? { rejectUnauthorized: true } : false,
    connectionTimeoutMillis: connectTimeoutMs,
    statement_timeout: statementTimeoutMs,
    application_name: 'open-estate-connector',
  });

export interface RelationalDbDeps {
  readonly secrets: SecretResolver;
  readonly clientFactory?: DbClientFactory;
}

/** Parses the secret JSON; errors name fields only, never values. */
export function parseDbSecret(secret: string): DbCredentials {
  let json: unknown;
  try {
    json = JSON.parse(secret);
  } catch {
    throw new Error('database secret is not valid JSON');
  }
  const parsed = rdsSecretSchema.safeParse(json);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((i) => i.path.join('.')))].join(', ');
    throw new Error(`database secret is invalid (fields: ${fields})`);
  }
  return parsed.data;
}

/** Reads rows of one SELECT in batches inside a read-only transaction and emits mapped records. */
export class RelationalDbConnector implements Connector<RelationalDbSettings> {
  readonly type = 'relational-db' as const;
  private state: ConnectorState = 'idle';
  private credentials: DbCredentials | undefined;
  private readonly clientFactory: DbClientFactory;

  constructor(private readonly deps: RelationalDbDeps) {
    this.clientFactory = deps.clientFactory ?? pgClientFactory;
  }

  async initialize(ctx: ConnectorContext<RelationalDbSettings>): Promise<void> {
    const secretRef = requireSecretRef(ctx.secretRef, RELATIONAL_DB_MODULE);
    this.credentials = parseDbSecret(await this.deps.secrets.get(secretRef));
    this.state = 'initialized';
  }

  async run(ctx: ConnectorContext<RelationalDbSettings>): Promise<void> {
    if (!this.credentials) throw new Error('connector not initialized');
    this.state = 'running';
    const { tls, connectTimeoutMs, statementTimeoutMs } = ctx.config;
    const client = this.clientFactory({
      credentials: this.credentials,
      tls,
      connectTimeoutMs,
      statementTimeoutMs,
    });
    try {
      await client.connect();
      // One snapshot for all batches, and the database refuses writes.
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await this.readAll(client, ctx);
      await client.query('COMMIT');
      this.state = 'succeeded';
    } catch (error) {
      this.state = 'failed';
      throw error;
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  reportStatus() {
    // Record outcomes are counted by the framework from the pipeline results.
    return { state: this.state, imported: 0, updated: 0, rejected: 0 };
  }

  private async readAll(
    client: DbClient,
    ctx: ConnectorContext<RelationalDbSettings>,
  ): Promise<void> {
    const { query, parameters, batchSize, maxRecords, mapping } = ctx.config;
    const inner = query.trim().replace(/;$/, '');
    const limitParam = parameters.length + 1;
    // Only the configured constant query and generated placeholders are concatenated.
    const paged = `SELECT * FROM (${inner}) AS oe_source LIMIT $${limitParam} OFFSET $${limitParam + 1}`;

    let emitted = 0;
    while (emitted < maxRecords) {
      const limit = Math.min(batchSize, maxRecords - emitted);
      const { rows } = await client.query(paged, [...parameters, limit, emitted]);
      for (const row of rows) {
        await ctx.emit(applyFieldMapping(row, mapping));
        emitted += 1;
      }
      if (rows.length < limit) return;
    }
  }
}

export function relationalDbModule(deps: RelationalDbDeps): ConnectorModule<RelationalDbSettings> {
  return {
    name: RELATIONAL_DB_MODULE,
    type: 'relational-db',
    settingsSchema: relationalDbSettingsSchema,
    create: () => new RelationalDbConnector(deps),
  };
}
