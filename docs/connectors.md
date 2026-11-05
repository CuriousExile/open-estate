# Connectors

Connectors bring listings into open-estate. A connector reads one data source and hands raw
records to the import pipeline. The pipeline validates and filters them and writes them to the
`Listings` table. This guide covers the built-in connectors, how to write and register a new one,
and how to deploy, run and debug it.

The code is the source of truth: `packages/ingestion/src` (framework, connectors, pipeline) and
`packages/infra/src/ingestion-stack.ts` (AWS resources). The example connector in this guide
also lives in `packages/ingestion/test/docs-example-connector.test.ts`. That test runs it and
fails if the code here and in the test drift apart. It also checks every JSON example in this
guide against its schema.

## Contents

- [Overview and data flow](#overview-and-data-flow)
- [Registering a connector: `connectors.json`](#registering-a-connector-connectorsjson)
- [Built-in connectors](#built-in-connectors)
- [Writing a new connector](#writing-a-new-connector)
- [Secrets](#secrets)
- [Personal data: `pii-allowlist.json`](#personal-data-pii-allowlistjson)
- [Deploy and run](#deploy-and-run)
- [Run log](#run-log)
- [Troubleshooting](#troubleshooting)

## Overview and data flow

```text
EventBridge Scheduler (schedule from connectors.json)
  → Step Functions state machine (one per connector, timeout = timeoutSeconds)
    → Lambda (one per connector, same timeout)
      → ConnectorFramework.runConnector(config)
          1. connector disabled?            → run.skipped, nothing runs
          2. resolve module in registry     → unknown module / type mismatch → CONFIG_REJECTED
          3. validate settings              → invalid → CONFIG_REJECTED (before initialize)
          4. connector.initialize(ctx)
          5. connector.run(ctx)  ── ctx.emit(raw) per record ──→ ImportPipeline.process(raw)
          6. run.finished with counters imported / updated / rejected
```

For every record passed to `ctx.emit`, the `ImportPipeline`
(`packages/ingestion/src/pipeline/import-pipeline.ts`) runs these steps in order:

1. **Mapping**: keeps only the top-level listing fields. Unknown fields and the provenance fields
   `source`, `lastImportedAt` and `lastRunId` are dropped. The pipeline expects the listing
   _input_ format: amounts and area as decimal strings, offers as `offers[]`. Mapping a source
   format to it is the connector's job.
2. **Deletion blocklist**: an id with a deletion request is rejected with reason `Löschsperre`.
3. **PII filter**: removes every personal-data field (`contact.name`, `contact.phone`,
   `contact.email`) that is not listed in `pii-allowlist.json`. See [below](#personal-data-pii-allowlistjson).
4. **Media and tour cleanup**: removes invalid entries (non-https, too long, tour host not in
   `tour-providers.json`), cuts the lists to 50 media / 10 tours and sets `providerCode` on tours.
   The rest of the listing is kept.
5. **Enrichment**: sets `source` (= connector id), `lastImportedAt` and `lastRunId`.
6. **Validation** against the listing schema with the loaded taxonomy and locales: required
   fields, bounds, listing type from `taxonomy.json`, locales, and the offer rules (1–2 offers,
   at most one per type, `SALE` has `price` and no rent fields, `RENT` has `coldRent` and
   `warmRent ≥ coldRent`). Every field issue is logged and the record is rejected.
7. **Write**: an atomic upsert. A new id counts as `imported` and an existing one as `updated`.
   The blocklist is checked again in the same transaction.

A record that fails a step is counted as `rejected` and the run goes on. A connector that throws
from `initialize` or `run` ends the run with status `FAILURE`. Records emitted before the throw
are already stored.

## Registering a connector: `connectors.json`

`connectors.json` lives in the config directory, `packages/shared/src/config/` by default (see
[Deploy and run](#deploy-and-run)). It is an array with one entry per connector. The schema is
`connectorsFileSchema` in `packages/ingestion/src/connector-config.ts`.

| Field            | Required | Description                                                                                                                                                                                 |
| ---------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`             | yes      | Unique lowercase slug of at most 64 characters (`a-z`, `0-9`, `-`). Used as the listing `source`, the run log `source`, the schedule name and the resource tag `open-estate:connector`.     |
| `type`           | yes      | `relational-db`, `external-api` or `web-crawler` (`CONNECTOR_TYPES`). Must match the module's type.                                                                                         |
| `module`         | yes      | Name of a module registered in the connector registry, e.g. `relational-db`. This is a lookup key, never a code path.                                                                       |
| `enabled`        | yes      | `false` disables the schedule. A run started by hand logs `run.skipped` and does nothing.                                                                                                   |
| `schedule`       | yes      | EventBridge Scheduler expression, evaluated in UTC: `rate(<n> <unit>)` (`minute`/`hour`/`day`, singular only for 1) or `cron(min hour day-of-month month day-of-week year)` with exactly one of day-of-month / day-of-week set to `?`. One-time `at(...)` is rejected. |
| `timeoutSeconds` | no       | Run time limit, 1–900 (Lambda maximum). Default `300`.                                                                                                                                      |
| `settings`       | no       | Module-specific settings. Default `{}`. Validated against the module's `settingsSchema` at the start of every run, not at synth.                                                            |
| `secretRef`      | no       | Secrets Manager secret name or ARN. The connector Lambda may read only this secret.                                                                                                         |

Unknown keys are rejected. `cdk synth` / `cdk deploy` validates the whole file (field rules,
duplicate ids, schedule syntax) and fails with every problem listed. Module settings are checked
only when a run starts: a wrong setting shows up as `config.rejected` in the run log, not as a
deploy error.

Changes to `connectors.json` take effect with the next deploy. The stack creates, changes or
removes the schedule, state machine and Lambda of each entry.

## Built-in connectors

`createDefaultRegistry` (`packages/ingestion/src/default-registry.ts`) registers three modules.
Their module names match the types.

### `relational-db` (PostgreSQL)

Runs one constant `SELECT`/`WITH` statement inside a read-only `REPEATABLE READ` transaction. It
reads in `LIMIT`/`OFFSET` batches and emits one mapped record per row. Settings
(`relationalDbSettingsSchema`):

| Setting              | Default  | Description                                                                                                                    |
| -------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `query`              | required | One `SELECT` or `WITH` statement, at most 10,000 characters. Needs a deterministic `ORDER BY` because batches use `OFFSET`.    |
| `parameters`         | `[]`     | Values for `$1`, `$2`, … (string, number, boolean, null; at most 100). Put values here, never into the query string.          |
| `batchSize`          | `500`    | Rows per batch (1–10,000).                                                                                                     |
| `maxRecords`         | `100000` | Upper bound per run.                                                                                                           |
| `tls`                | `true`   | TLS with certificate verification. Trust the RDS CA via `NODE_EXTRA_CA_CERTS` if needed.                                       |
| `connectTimeoutMs`   | `10000`  | 100–60,000.                                                                                                                    |
| `statementTimeoutMs` | `60000`  | 100–900,000. Per statement, on the server side.                                                                                |
| `mapping`            | required | [Field mapping](#field-mapping) from row columns to listing fields.                                                            |

`secretRef` is required. The secret holds the RDS-style JSON
`{ "engine": "postgres", "host": "…", "port": 5432, "username": "…", "password": "…", "dbname": "…" }`.
Use a read-only database user.

```json
[
  {
    "id": "partner-db",
    "type": "relational-db",
    "module": "relational-db",
    "enabled": true,
    "schedule": "cron(0 3 * * ? *)",
    "timeoutSeconds": 600,
    "secretRef": "open-estate/partner-db",
    "settings": {
      "query": "SELECT * FROM listings WHERE status = $1 ORDER BY ref",
      "parameters": ["published"],
      "batchSize": 500,
      "mapping": {
        "fields": {
          "id": "ref",
          "title": "headline",
          "description": "text",
          "listingType": "kind",
          "rooms": "rooms",
          "area": "living_area",
          "address.city": "city",
          "address.postalCode": "zip",
          "address.country": "country",
          "sourceUrl": "url",
          "offers[0].price": "sale_price"
        },
        "constants": {
          "originalLocale": "de",
          "translations": [],
          "media": [],
          "offers[0].offerType": "SALE",
          "offers[0].currency": "EUR"
        }
      }
    }
  }
]
```

### `external-api` (REST, JSON)

Sends `GET` requests to an https endpoint, reads a record array from each response and emits one
mapped record per item. Settings (`externalApiSettingsSchema`):

| Setting        | Default            | Description                                                                                                                                                                                                     |
| -------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `endpoint`     | required           | `https://` URL without credentials.                                                                                                                                                                             |
| `headers`      | `{}`               | Static headers that are not secret. `Authorization` is not allowed here.                                                                                                                                        |
| `secretHeader` | none               | `{ "name": "Authorization", "prefix": "Bearer " }`: header set to `prefix` + the secret string of `secretRef`.                                                                                                  |
| `query`        | `{}`               | Static query parameters.                                                                                                                                                                                        |
| `recordsPath`  | none               | Path to the record array in the response, e.g. `data.items`. If omitted, the body must be the array.                                                                                                            |
| `pagination`   | `{"type": "none"}` | `none`, `{ "type": "cursor", "cursorPath", "cursorParam", "maxPages" = 1000 }` (an empty or missing cursor ends the run) or `{ "type": "page-number", "pageParam", "startPage" = 1, "maxPages" }`. An empty page always ends the run. |
| `timeoutMs`    | `10000`            | Per request, 100–60,000.                                                                                                                                                                                        |
| `maxRecords`   | `10000`            | Upper bound per run.                                                                                                                                                                                            |
| `mapping`      | required           | [Field mapping](#field-mapping) from item fields to listing fields.                                                                                                                                             |

A non-2xx response fails the run. Only the status is logged, never the body.

```json
[
  {
    "id": "partner-api",
    "type": "external-api",
    "module": "external-api",
    "enabled": true,
    "schedule": "rate(1 hour)",
    "secretRef": "open-estate/partner-api-token",
    "settings": {
      "endpoint": "https://api.partner.example/v2/listings",
      "headers": { "x-tenant": "acme" },
      "secretHeader": { "name": "Authorization", "prefix": "Bearer " },
      "query": { "status": "active" },
      "recordsPath": "data.items",
      "pagination": {
        "type": "cursor",
        "cursorPath": "data.nextCursor",
        "cursorParam": "cursor",
        "maxPages": 200
      },
      "maxRecords": 20000,
      "mapping": {
        "fields": {
          "id": "ref",
          "title": "headline",
          "description": "text",
          "listingType": "kind",
          "rooms": "rooms",
          "area": "livingArea",
          "address.city": "location.city",
          "address.postalCode": "location.zip",
          "address.country": "location.country",
          "geo.lat": "location.lat",
          "geo.lon": "location.lon",
          "sourceUrl": "url",
          "offers[0].price": "salePrice",
          "offers[1].coldRent": "coldRent",
          "offers[1].warmRent": "warmRent"
        },
        "constants": {
          "originalLocale": "de",
          "translations": [],
          "media": [],
          "offers[0].offerType": "SALE",
          "offers[0].currency": "EUR",
          "offers[1].offerType": "RENT",
          "offers[1].currency": "EUR"
        }
      }
    }
  }
]
```

### Field mapping

`relational-db` and `external-api` share the field mapping format (`fieldMappingSchema` in
`packages/ingestion/src/connectors/field-mapping.ts`). It is plain data, with no expressions or
code:

- `fields`: _target path_ → _source path_. The target is a listing input path and the source is a
  path in the row or item.
- `constants`: _target path_ → fixed JSON value. Constants are applied after `fields` and win on
  conflicts.
- Paths use dots and array indices: `address.city`, `location.zip`, `offers[0].price`. Indices
  go up to 99. `__proto__`, `prototype` and `constructor` are rejected.
- A source value that is missing or `null` is skipped and the target stays absent. Validation then
  decides whether the field was required. For example, a `SALE` offer without `price` is rejected.
- At least one entry in `fields` or `constants` is required.

Values are not converted. Amounts and area must be decimal strings (`"320000.00"`, `"88.5"`).
`rooms` and coordinates must be numbers. Convert in the query, e.g.
`SELECT price::text AS sale_price …`, or write your own connector.

### `web-crawler`

Crawls only the configured start URLs. It never follows links. Each URL passes the compliance
check first, then the page is fetched and listings are extracted. Settings:

| Setting     | Default             | Description                                                                                                         |
| ----------- | ------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `startUrls` | required            | 1–1,000 http(s) URLs without credentials, at most 2,048 characters each. Only these pages are fetched.             |
| `userAgent` | `OpenEstateBot/0.0 (+https://github.com/CuriousExile/open-estate)` | Full User-Agent. Its product token (`OpenEstateBot`) selects the robots.txt group.   |
| `extractor` | `json-ld`           | Extractor name. Operators can inject more extractors through `WebCrawlerModuleOptions.extractors`.                  |

```json
[
  {
    "id": "partner-site",
    "type": "web-crawler",
    "module": "web-crawler",
    "enabled": true,
    "schedule": "cron(30 2 ? * MON *)",
    "timeoutSeconds": 900,
    "settings": {
      "startUrls": [
        "https://www.partner.example/angebote/1001",
        "https://www.partner.example/angebote/1002"
      ],
      "userAgent": "OpenEstateBot/1.0 (+https://estate.example/bot)",
      "extractor": "json-ld"
    }
  }
]
```

**Crawl only sources you are legally allowed to crawl.** Typical grounds are written permission
from the site operator, a contract or a licence. The crawler is default-deny. The
`ComplianceChecker` runs these rules in order for every start URL, and the first match decides:

1. The origin is not in `crawler-allowlist.json` → denied (`nicht auf Erlaubnisliste`), with no
   network access.
2. The `legalBasis` of the target is missing or blank → denied (`fehlende Rechtsgrundlage`).
3. robots.txt cannot be fetched (10 s timeout, network error, non-2xx) → denied
   (`robots.txt nicht abrufbar`). This is stricter than RFC 9309.
4. robots.txt disallows the path for the User-Agent → denied (`robots.txt untersagt Pfad`).
5. Otherwise allowed (`zulässig`).

Every decision is logged as `crawl.checked` with URL, result, reason and timestamp. robots.txt is
read again on every run. Requests per origin are rate-limited: `ratePerSecond` from the
allowlist (0.1–100), default 1 request per second. If an allowed page fails (timeout, non-2xx,
larger than 5,000,000 characters), it is logged as `crawl.page_failed` and skipped.

`crawler-allowlist.json` sits next to `connectors.json`. It is read on every run, so changes
apply without a restart. `origin` must be a bare `scheme://host[:port]`.

```json
{
  "targets": [
    {
      "origin": "https://www.partner.example",
      "legalBasis": "Written crawl permission from Partner GmbH, 2026-10-01, contract 2026-17",
      "ratePerSecond": 0.5,
      "notes": "Contact: data team"
    }
  ]
}
```

The `json-ld` extractor takes every top-level JSON-LD node (arrays and `@graph` are flattened)
whose `@type` is `RealEstateListing`, `Offer`, `SingleFamilyResidence`, `Apartment` or `House`.
It drops the `@…` keywords and sets `sourceUrl` to the page URL unless the node has one. It does
**not** translate schema.org vocabulary. Nodes must already use listing field names (`id`,
`title`, `offers`, …), which suits partner pages built for this purpose. For other markup,
inject your own extractor, a pure function `(html, url) => RawRecord[]`.

## Writing a new connector

A connector is a module that implements a small contract. The framework core does not change.

### Interface

From `packages/ingestion/src/connector.ts` and `registry.ts`:

```ts
interface Connector<TSettings = unknown> {
  readonly type: ConnectorType; // 'relational-db' | 'external-api' | 'web-crawler'
  initialize(ctx: ConnectorContext<TSettings>): Promise<void>;
  run(ctx: ConnectorContext<TSettings>): Promise<void>;
  reportStatus(): ConnectorStatus; // { state, imported, updated, rejected }
}

interface ConnectorContext<TSettings = unknown> {
  readonly config: TSettings; // `settings`, already parsed by settingsSchema (defaults applied)
  readonly secretRef?: string; // name/ARN from connectors.json; resolve it yourself
  readonly runId: string;
  readonly logger: RunLogger; // value-free run log
  emit(raw: RawRecord): Promise<void>; // one record into the import pipeline
}

interface ConnectorModule<TSettings = unknown> {
  readonly name: string; // referenced by connectors.json → module
  readonly type: ConnectorType;
  readonly settingsSchema: ZodType<TSettings>;
  create(): Connector<TSettings>; // fresh instance per run
}
```

### Mandatory operations

| Operation            | Contract                                                                                                                                                                                                                                                   |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `initialize(ctx)`    | Called once per run, after the settings passed validation. Resolve secrets, open clients, load whatever the run needs. Throwing ends the run with `FAILURE` (`connector.error`, reason `initialize failed: …`).                                            |
| `run(ctx)`           | Read the source and call `await ctx.emit(raw)` once per record, sequentially. `emit` resolves after the pipeline has processed the record and never throws for bad records: they are counted as `rejected`. Throw only if the run itself fails (source unreachable, bad response format). |
| `reportStatus()`     | Return the lifecycle `state` (`idle` → `initialized` → `running` → `succeeded`/`failed`). The authoritative counters come from the framework, which counts pipeline outcomes. The built-in modules return `0` for the counters.                             |
| `settingsSchema`     | A Zod schema for `settings`. Use `z.strictObject` so typos are rejected. Put defaults here: `ctx.config` is the parsed output.                                                                                                                              |

Rules every connector must follow:

- **Never log or throw field values or secrets.** Use `ctx.logger` only. Its methods accept ids,
  field names and reasons, never records. Keep error messages value-free: a status code is fine,
  a response body is not. Error messages appear in the run log (`connector.error`).
- **Emit the listing input format.** The pipeline drops unknown top-level fields and does not
  convert values.
- **Respect the time limit.** The Lambda is stopped after `timeoutSeconds`. Cap the work per run
  (e.g. a `maxRecords` setting) and set timeouts on network calls.
- **Stateless between runs.** `create()` is called for every run, so keep per-run state on the
  instance. Deduplication across runs comes from the upsert by `id`. Give ids a stable prefix per
  source, e.g. `pf-<ref>`, so ids from different sources cannot collide.
- **Read-only access to the source.** Settings come from a config file in a bucket, so treat them
  as configuration, not code. Never build queries or URLs from record values.
- `type` must be one of `CONNECTOR_TYPES`. Pick the one that fits the source. A new source type
  needs a change to `CONNECTOR_TYPES` in `connector.ts`, which is a core change. Discuss it in an
  issue first.

### Complete example: `partner-feed`

A connector for a partner that publishes its listings as one JSON array over https. It has an
optional API key and does its own mapping in code instead of the generic field mapping. Save it as
`packages/ingestion/src/connectors/partner-feed.ts`:

```ts
import { z } from 'zod';
import type {
  Connector,
  ConnectorContext,
  ConnectorState,
  ConnectorStatus,
  RawRecord,
} from '../connector';
import type { ConnectorModule } from '../registry';
import type { FetchLike } from './external-api';
import type { SecretResolver } from './secrets';

export const PARTNER_FEED_MODULE = 'partner-feed';

/** `connectors.json` → `settings`; validated by the framework before `initialize`. */
export const partnerFeedSettingsSchema = z.strictObject({
  /** https only; credentials never go into settings, they come from `secretRef`. */
  feedUrl: z.url({ protocol: /^https$/ }),
  originalLocale: z.string().min(2).max(35).default('de'),
  country: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .default('DE'),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .default('EUR'),
  timeoutMs: z.int().min(100).max(60_000).default(10_000),
  maxRecords: z.int().min(1).max(100_000).default(10_000),
});
export type PartnerFeedSettings = z.output<typeof partnerFeedSettingsSchema>;

/** Runtime dependencies that do not belong into `connectors.json`. */
export interface PartnerFeedDeps {
  /** Resolves `secretRef` (here: an API key); AWS Secrets Manager in production. */
  readonly secrets: SecretResolver;
  /** Injectable for tests; defaults to the global `fetch`. */
  readonly fetch?: FetchLike;
}

type FeedItem = Readonly<Record<string, unknown>>;

const isFeedItem = (value: unknown): value is FeedItem =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Source format → listing input format. Values are passed through unchecked: validation,
 * PII filtering and media cleanup are the import pipeline's job.
 */
function toListingInput(item: FeedItem, settings: PartnerFeedSettings): RawRecord {
  const images: unknown[] = Array.isArray(item['images']) ? item['images'] : [];
  return {
    // Missing `ref` ⇒ no `id` ⇒ the record is rejected by validation.
    ...(typeof item['ref'] === 'string' && { id: `pf-${item['ref']}` }),
    originalLocale: settings.originalLocale,
    title: item['headline'],
    description: item['text'] ?? '',
    translations: [],
    offers: [{ offerType: 'SALE', price: item['price'], currency: settings.currency }],
    listingType: item['kind'],
    rooms: item['rooms'],
    area: item['livingArea'],
    address: { city: item['city'], postalCode: item['zip'], country: settings.country },
    sourceUrl: item['url'],
    media: images.map((url) => ({ url })),
    // PII: dropped by the pipeline unless `contact.email` is in `pii-allowlist.json`.
    ...(item['agentEmail'] !== undefined && { contact: { email: item['agentEmail'] } }),
  };
}

/** Reads one JSON array from an https feed (GET) and emits one record per item. */
class PartnerFeedConnector implements Connector<PartnerFeedSettings> {
  readonly type = 'external-api' as const;
  private state: ConnectorState = 'idle';
  private readonly headers: Record<string, string> = { accept: 'application/json' };

  constructor(private readonly deps: PartnerFeedDeps) {}

  async initialize(ctx: ConnectorContext<PartnerFeedSettings>): Promise<void> {
    // Secret values are never logged and never put into error messages.
    if (ctx.secretRef !== undefined) {
      this.headers['x-api-key'] = await this.deps.secrets.get(ctx.secretRef);
    }
    this.state = 'initialized';
  }

  async run(ctx: ConnectorContext<PartnerFeedSettings>): Promise<void> {
    const { feedUrl, timeoutMs, maxRecords } = ctx.config;
    const fetchFn: FetchLike = this.deps.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.state = 'running';
    try {
      const response = await fetchFn(feedUrl, {
        method: 'GET',
        headers: { ...this.headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
      // Status only: error bodies may echo request headers (the API key).
      if (!response.ok) throw new Error(`HTTP ${response.status} from partner feed`);
      const body = await response.json();
      if (!Array.isArray(body)) throw new Error('partner feed is not a JSON array');
      for (const item of body.slice(0, maxRecords)) {
        // Non-objects are emitted empty, so they show up as rejected in the run counters.
        await ctx.emit(isFeedItem(item) ? toListingInput(item, ctx.config) : {});
      }
      this.state = 'succeeded';
    } catch (error) {
      this.state = 'failed';
      throw error; // the framework logs it and finishes the run with status FAILURE
    }
  }

  reportStatus(): ConnectorStatus {
    // imported/updated/rejected are counted by the framework from the pipeline outcomes.
    return { state: this.state, imported: 0, updated: 0, rejected: 0 };
  }
}

export function partnerFeedModule(deps: PartnerFeedDeps): ConnectorModule<PartnerFeedSettings> {
  return {
    name: PARTNER_FEED_MODULE,
    type: 'external-api',
    settingsSchema: partnerFeedSettingsSchema,
    create: () => new PartnerFeedConnector(deps),
  };
}
```

Export it from `packages/ingestion/src/connectors/index.ts`:

```ts
export * from './partner-feed';
```

### Registering the module (code)

The registry is a closed map of module name → module. `connectors.json` cannot load code: the file
lives in a bucket and must not be able to run arbitrary code. Add the module where the
production registry is built, in `createDefaultRegistry`
(`packages/ingestion/src/default-registry.ts`):

```ts
import { partnerFeedModule, type PartnerFeedDeps } from './connectors/partner-feed';

export interface DefaultRegistryDeps {
  // …existing entries…
  readonly partnerFeed?: Omit<PartnerFeedDeps, 'secrets'>;
}

export function createDefaultRegistry(deps: DefaultRegistryDeps): ConnectorRegistry {
  const secrets = deps.secrets ?? new SecretsManagerSecretResolver();
  return new ConnectorRegistry([
    createWebCrawlerModule(deps.webCrawler),
    relationalDbModule({ ...deps.relationalDb, secrets }) as ConnectorModule,
    externalApiModule({ ...deps.externalApi, secrets }) as ConnectorModule,
    partnerFeedModule({ ...deps.partnerFeed, secrets }) as ConnectorModule,
  ]);
}
```

- The `as ConnectorModule` cast is needed because a `ZodType<PartnerFeedSettings>` is not
  assignable to `ZodType<unknown>`. The framework parses `settings` with the module's own schema
  before it calls the connector, so the cast is safe.
- Module names must be unique. `register()` throws on duplicates.
- In tests, build the registry with `new ConnectorRegistry([...])` or
  `createDefaultRegistry(deps).register(module)`.
- Test the module like the example test does: run it through `ConnectorFramework` with the real
  `ImportPipeline`, an `InMemoryListingWriter`, a fake `fetch` and `createFakeSecrets`, and assert
  on the run summary and the stored listings.

All connector Lambdas bundle the same entry (`connector-handler.ts`), so the new module ships
with the next deploy.

### Registering the connector (configuration)

Add an entry to `connectors.json` with `module` set to the module name and `type` set to the
module's type:

```json
[
  {
    "id": "partner-feed",
    "type": "external-api",
    "module": "partner-feed",
    "enabled": true,
    "schedule": "rate(6 hours)",
    "timeoutSeconds": 300,
    "secretRef": "open-estate/partner-feed",
    "settings": {
      "feedUrl": "https://feed.partner.example/listings.json",
      "originalLocale": "de",
      "maxRecords": 5000
    }
  }
]
```

## Secrets

Credentials never go into `connectors.json` or `settings`. Store them in AWS Secrets Manager and
put the secret name or ARN into `secretRef`:

```sh
aws secretsmanager create-secret --name open-estate/partner-feed --secret-string '<api key>'
```

- At deploy time the stack grants the connector's Lambda `secretsmanager:GetSecretValue` on
  exactly this secret and no other. A name or partial ARN matches through the
  `-??????` suffix that Secrets Manager appends, so the secret can be created before or after the
  deploy.
- At run time the connector receives `ctx.secretRef` and resolves the value itself, through
  `SecretResolver` (`SecretsManagerSecretResolver` in production).
- The secret must have a `SecretString`. Binary secrets are not supported.
- If the secret is encrypted with a customer-managed KMS key, see
  [Troubleshooting](#troubleshooting).

## Personal data: `pii-allowlist.json`

Listing fields marked as PII (`contact.name`, `contact.phone`, `contact.email`) are removed on
import unless the field is allow-listed. The default is to drop all of them. The file is global
and applies to every connector:

```json
{ "allowedFields": ["contact.name", "contact.email"] }
```

Only known PII paths are accepted, so a typo fails the deploy. A missing file or an empty list
drops all PII fields. Every dropped field is logged as `pii.field_dropped` with listing id and
field name, never the value. Allow-list a field only if you have a legal basis for publishing it.
Connectors themselves must not log, store or forward personal data.

## Deploy and run

1. Put your config files into a directory: `connectors.json`, optionally `pii-allowlist.json`,
   `crawler-allowlist.json` and `tour-providers.json`, plus the required `taxonomy.json`. The
   repository default is `packages/shared/src/config/`. Copy it as a starting point. Unknown file
   names are rejected. Leave `i18n-config.json` out: it is mirrored from the frontend.
2. Deploy. Synth validates every file and creates one schedule, one state machine and one Lambda
   per connector:

   ```sh
   npm ci
   npm run build
   npm run deploy --workspace @open-estate/infra -- -c configDir=/path/to/my-config
   # or, inside packages/infra: npx cdk deploy --all -c configDir=/path/to/my-config
   ```

   Add `-c env=<name>` for environments other than `dev`. Stacks are named
   `OpenEstate-<env>-*`, connectors live in `OpenEstate-<env>-Ingestion`.

3. The schedule starts runs automatically when `enabled` is `true`. To start a run by hand, find
   the state machine by its tag and start an execution:

   ```sh
   ARN=$(aws resourcegroupstaggingapi get-resources \
     --resource-type-filters states:stateMachine \
     --tag-filters Key=open-estate:connector,Values=partner-feed \
     --query 'ResourceTagMappingList[0].ResourceARN' --output text)
   aws stepfunctions start-execution --state-machine-arn "$ARN" \
     --name "manual-$(date +%Y%m%dT%H%M%S)" --input '{"connectorId":"partner-feed"}'
   ```

   The input has the same shape the schedule sends:

   ```json
   { "connectorId": "partner-feed" }
   ```

   The execution name becomes the run's `runId`, which links execution history, run log and the
   `lastRunId` of the stored listings. A run summary with status `FAILURE` fails the execution
   with error `ConnectorRunFailed`.

The Lambda loads `connectors.json`, `taxonomy.json`, locales and the PII/tour allowlists once per
instance. Warm instances keep the old files until they start cold. If only these files changed,
by a deploy or by an edit in the config bucket, force a cold start with
`open-estate-admin reload --function <connector function name>`, which bumps `CONFIG_VERSION`.
Schedules, timeouts and secret permissions come from `connectors.json` at deploy time, so changes
to those always need a redeploy. `crawler-allowlist.json` is read on every run.

## Run log

Every run writes structured JSON lines to the connector Lambda's CloudWatch log group. Each line
has `timestamp`, `level`, `event`, `runId` and `source` (the connector id). Field values and
secrets are never logged.

| Event               | Level      | Extra fields                                                         |
| ------------------- | ---------- | -------------------------------------------------------------------- |
| `run.started`       | info       | `connectorType`                                                      |
| `run.finished`      | info/error | `status` (`SUCCESS`/`FAILURE`), `startedAt`, `endedAt`, `imported`, `updated`, `rejected` |
| `run.skipped`       | info       | `reason` (connector disabled)                                        |
| `config.rejected`   | error      | `issues[]` with `field` and `reason`                                 |
| `record.rejected`   | warn       | `listingId` (if valid), `issues[]` with `field` and `reason`         |
| `pii.field_dropped` | info       | `listingId`, `field`                                                 |
| `media.dropped`     | warn       | `listingId`, `kind` (`media`/`tour`), `index`, `reason`, `url` (tours only) |
| `media.truncated`   | warn       | `listingId`, `kind`, `droppedCount`                                  |
| `crawl.checked`     | info/warn  | `url`, `result` (`ALLOWED`/`DENIED`), `reason`, `checkedAt`          |
| `crawl.page_failed` | warn       | `url`, `reason`                                                      |
| `connector.error`   | error      | `reason` (`initialize failed: …` / `run failed: …`)                  |
| `init.failed`       | error      | Lambda could not load its configuration. Nothing runs.               |

Example of a finished run:

```json
{
  "timestamp": "2026-11-05T03:04:12.345Z",
  "level": "info",
  "event": "run.finished",
  "runId": "manual-20261105T030000",
  "source": "partner-feed",
  "status": "SUCCESS",
  "startedAt": "2026-11-05T03:00:01.002Z",
  "endedAt": "2026-11-05T03:04:12.345Z",
  "imported": 120,
  "updated": 845,
  "rejected": 3
}
```

CloudWatch Logs Insights query for the run history of a connector:

```text
fields @timestamp, runId, status, imported, updated, rejected
| filter event = "run.finished" and source = "partner-feed"
| sort @timestamp desc
```

Use `filter runId = "<runId>" and level != "info"` for the problems of a single run.

## Troubleshooting

| Symptom                                                                       | Cause and fix                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cdk synth`/`deploy` fails with `Invalid configuration in …: connectors.json: …` | The file breaks `connectorsFileSchema`: unknown key, bad slug, duplicate id, `timeoutSeconds` > 900, or invalid `schedule` (singular/plural unit, both or neither cron day field set to `?`). Fix the listed paths and deploy again.                                                                                                                         |
| `config.rejected` with field `module` or `type`, run status `FAILURE`         | `UNKNOWN_MODULE`: the module is not registered in `createDefaultRegistry`, or the deployed code is older than the config. `TYPE_MISMATCH`: `type` in `connectors.json` differs from the module's `type`. Register the module, or fix the entry, and redeploy.                                                                                                  |
| `config.rejected` with fields `settings.…`                                    | The settings break the module's `settingsSchema`. They are checked only at run time, not at synth. The `reason` gives the rule (e.g. invalid URL, unknown key). `initialize` was not called.                                                                                                                                                                  |
| Many `record.rejected` with reason `Löschsperre`                              | The listing ids are on the deletion blocklist because of a deletion request. This is intended: the source keeps delivering the listing and the platform refuses it. Have the source remove the listing. Do not work around it by changing ids.                                                                                                                 |
| `record.rejected` with field issues                                           | The mapped record breaks the listing schema. Common causes: amounts or area as numbers instead of decimal strings, `listingType` not in `taxonomy.json`, `originalLocale` not enabled, a `SALE` offer with rent fields, `warmRent < coldRent`, a missing required field (the source value was `null`). Fix the mapping or the source data.                       |
| Execution fails with `States.Timeout`, or the Lambda log shows `Task timed out` | The run took longer than `timeoutSeconds`. Raise it (max 900), lower `maxRecords`/`maxPages`, or split the source into several connectors. Records emitted before the timeout are stored, and the next run upserts the rest. Other connectors are not affected.                                                                                                |
| `connector.error` … `AccessDeniedException` … `GetSecretValue`                | The Lambda may read only the secret in `secretRef`. Check that the secret exists in the same account and region under exactly that name or ARN. After changing `secretRef`, redeploy so the IAM policy follows. A `requires secretRef` error means the module needs a secret and the entry has none.                                                     |
| `connector.error` … `KMS` / `AccessDeniedException` … `Decrypt`               | The secret uses a customer-managed KMS key, and the stack does not grant `kms:Decrypt`. Allow the connector Lambda role in the key policy, or use the default `aws/secretsmanager` key.                                                                                                                                                                         |
| `relational-db`: connect timeout / `ETIMEDOUT` to a private database          | Connector Lambdas do not run in a VPC, so they reach only publicly reachable endpoints. For a database in private subnets, extend `IngestionStack` (`vpc`, `vpcSubnets` and `securityGroups` on the connector `NodejsFunction`). The Lambda then also needs a route to DynamoDB, S3 and Secrets Manager (VPC endpoints or NAT). Allow the Lambda's security group in the database's security group. |
| `relational-db`: TLS errors (`self-signed certificate`, `unable to verify`)   | `tls` verifies certificates. Provide the RDS CA bundle via `NODE_EXTRA_CA_CERTS` instead of switching `tls` off.                                                                                                                                                                                                                                                 |
| `crawl.checked` with `result: DENIED`                                         | The `reason` names the rule: origin not allow-listed, missing `legalBasis`, robots.txt unreachable or disallowing the path. Fix the allowlist only if the legal basis really exists.                                                                                                                                                                               |
| Crawler run succeeds with `imported: 0`                                       | The pages have no JSON-LD node of a supported `@type`, or the nodes do not use listing field names (see `record.rejected`). Use or inject a matching extractor.                                                                                                                                                                                                 |
| `init.failed`, every execution fails right away                              | The Lambda could not load its configuration (missing or invalid file in the config bucket, invalid taxonomy). The log line lists the affected files. Fix them and redeploy or reload.                                                                                                                                                                            |
| `UnknownConnectorError`                                                       | The execution input named a different `connectorId` than the one this state machine/Lambda was deployed for. Start the state machine of that connector.                                                                                                                                                                                                         |
