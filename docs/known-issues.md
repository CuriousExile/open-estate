# Known issues

Open concerns from implementing the listing management (agency portal, versioning, Management
API). Nothing here blocks the tests; each item should be decided or fixed before a release. The
specification lives in [`.kiro/specs/listing-management/`](../.kiro/specs/listing-management/).

## Not verified

- **No deployment.** No stack has been deployed. Synthesis is only covered by CDK assertion tests;
  the one-command deploy into an empty account (ROADMAP v1.0) is unverified, including the new
  stack order (Data → ManagementData → Api → Monitoring → Ingestion → Admin → Frontend → Identity →
  Management).
- **No Cognito test.** The public search, the portal (login with Code + PKCE against the local
  OIDC provider, guards, bearer interceptor, every area) and admin mode have Playwright tests
  (`packages/browser-tests`); nothing ran against a real Cognito user pool.
- **Access mode is write-only.** It can be set but not read back (no `GET`), so the operations
  page always shows "Open" after a reload. More findings of the browser tests:
  [packages/browser-tests/README.md](../packages/browser-tests/README.md#known-issues-found-by-these-tests).
- **No integration tests** (task 16.1): role changes, suspensions and revocations within 60 s,
  visibility in DynamoDB and OpenSearch search, deletion of versions and S3 snapshots, usage lines
  reaching the counters within 15 min.
## Frontend

- **Bundle size.** The initial bundle is about 690 kB, under the 700 kB warning budget (the
  listing detail view, the result list and the "More filters" sheet are lazy chunks; theme switch,
  display currency and the inline theme script added about 8 kB, offset by deferring the result
  list). The main
  parts are Angular (~395 kB incl. router and forms), `angular-auth-oidc-client` (~135 kB) and zod
  (~130 kB). The OIDC client cannot move into the lazy portal chunks: its services are
  `providedIn: 'root'` and need `StsConfigLoader` and the storage/logger tokens at root, and its
  bundle does not tree-shake, so any root import pulls all of it. zod stays small only with
  `import * as z from 'zod'` (enforced by lint) and `sideEffects: false` in shared.
- **Light/dark theme and display currency have no browser test.** Their models (theme
  preference, inline script parity, light palette derivation, price conversion and formatting) are
  unit-tested; both themes were checked in headless Chromium only. Contrast was checked for the
  default palette; explicit `colors.light` values of a deployment are not checked.
- **Native dropdowns left in the portal.** The property type selects of the listing form and the
  listing table group types by property group (`<optgroup>`); `oe-select` has no option groups
  yet, so they stay native `<select>`. All other dropdowns use `oe-select`.
- **Browser tests of `oe-select`, rooms chips and "More filters" cover mouse, keyboard and focus**
  (`packages/browser-tests`); screen reader output itself is still only checked manually. Issues
  these tests found and that are still open (a listing without `[DEMO]` marker, no favicon, …)
  are listed in
  [packages/browser-tests/README.md](../packages/browser-tests/README.md#known-issues-found-by-these-tests).
- **Hero image cache.** `hero-background.png` kept its file name; browsers that cached the old PNG
  under the one-year `immutable` header and do not support AVIF/WebP keep the old image.
- **More filters:** only filters the Search_API supports today (area, max. rooms, postal code, 3D
  tour). State, region, bathrooms, pool or floor need backend filters first; see
  [configuration](configuration.md#adding-a-filter-to-more-filters).
- **Two diff views.** The listing form uses `portal/shared/diff-view`, the workspace its own
  `workspace/version-diff.component.ts`. Merge them.
- **`toPublicDetailModel`** lives in the workspace folder and mirrors the Search_API's
  serialization. If the Search_API changes how it picks the language version, the preview drifts
  silently; property test 14.6 is not written yet.
- **Hidden detail fields are not configurable yet.** The public detail view hides coordinates,
  languages, listing ID, source, import time and run ID (`DETAIL_ROWS_HIDDEN_BY_DEFAULT` in
  `listing-detail-model.ts`; `toListingDetail` accepts `showRows` to switch single rows on). An
  agency setting that chooses the visible fields is still to be designed: where it is stored
  (agency record, Management API, portal page), and whether the Search_API and MCP_Server should
  omit hidden fields too. Today they are only hidden in the SPA and still in the API response.
- **`oe-image-carousel`:** buttons, arrow keys, mouse drag, touch swipe and the placeholders
  (no image, broken image) have browser tests; screen reader behaviour is checked manually only.
- **Opened listing in the URL.** A listing opened from the results is `&listing=<id>` on the search
  URL; on a reload it is fetched from the Search_API. If that fails (unknown, no longer public,
  network), the parameter is dropped and the results show, without a notice.

## Management API

- **Deadline does not cancel work.** The handler answers 503 after 4.5 s, but core services
  (`ListingCommandService`, `MonitoringService`, `MonitoringQueries`, `AuditLogReader`, the
  identity services) accept no `AbortSignal`. A slow request can keep running, and in rare cases
  write, after the client got its 503. Listing writes only check the signal before they start.
- **Monitoring deadline 2 s instead of 10 s.** Req 14.7 allows 10 s per source, but the whole
  request must finish within 4.5 s, so each source gets 2 s (`MANAGEMENT_MONITORING_SOURCE_DEADLINE_MS`).
- **`/monitoring/agency-activity`** goes through agencies one at a time in core; with many agencies
  it can exceed the deadline. Needs batching or a precomputed counter.
- **Agency overview** has no `lastChangedAt`: nothing stores it yet.
- **API key revocation has no dry run** (the Admin_API has none), so the admin confirmation dialog
  shows no affected count for it.
- **Failed `access-denied` audit writes** are only logged; the 401/403 is still returned. Decide
  whether that is acceptable for the audit requirements (Req 2.8).
- **Duplicated constants.** `pii-allowlist.json` is repeated in management (it can't depend on
  ingestion). Infra mirrors the route-group env names (`MANAGEMENT_ROUTE_ENV`) because the
  management package index does not export them; a test catches drift, but exporting them would be
  cleaner.
- **Management depends on `@open-estate/admin`** to reuse the deletion stores and the Step
  Functions starter. Moving those into core would remove the dependency.

## Infrastructure

- **CSP is broad.** `connect-src` allows `https://*.execute-api.<region>.<suffix>`, i.e. every API
  Gateway in the region, because the FrontendStack is deployed before the Management_API exists. A
  custom domain for the Management_API would allow an exact origin.
- **`img-src 'self' https:` on purpose.** Listing media are hosted by agencies and connectors on
  any https host (Req 16.1), so the CSP cannot list them; `img-src 'self'` alone would block every
  real listing image. Plain `http:` and `data:` stay blocked (the image placeholder is inline SVG
  markup, not a data URL); a test pins the directive. To narrow it, platform-hosted media are the
  way: copy imported images into an S3 bucket behind the CloudFront distribution (resizing and
  variants at the same time) and allow only that origin. Planned for later, not designed yet.
- **CORS lives in an infra wrapper** (`infra/src/lambda/management-cors.ts`) around the management
  handler, not in `packages/management`.
- **`runtime-config.json` is written by the ManagementStack**, not the FrontendStack. Deploying the
  frontend without the ManagementStack leaves the old file; a missing ManagementStack means no
  portal configuration.
- **CloudWatch reads use `*`** (`GetMetricData`, `ListMetrics`, `DescribeAlarms` have no resource
  scoping).

## Search API

- **`GET /locations` with DynamoDB reads every public listing.** The DynamoDB provider has no
  index to aggregate on, so a cache miss runs a projection query over the whole `byId` index
  (country, city and owner only, all pages) — read cost grows linearly with the number of listings,
  and the scan shares the 4.5 s downstream deadline, so very large tables (≫ 10,000 listings) can answer
  503. Each Lambda instance caches the rows for 5 minutes (`DYNAMODB_LOCATIONS_CACHE_TTL_MS`);
  listings published or removed in that time appear late. Suspensions are applied per request.
  With OpenSearch the endpoint is a single terms aggregation (at most 250 countries and 1,000 cities
  per country, `OPENSEARCH_LOCATION_LIMITS`).
- **City names are not translated.** `/locations` and the city filter use the stored
  `address.city`; "München" and "Munich" are different cities. Country names are localized in the
  frontend only (`Intl.DisplayNames`).
- **Exchange rates are static configuration.** `exchange-rates.json` (config bucket, `/meta`
  `exchangeRates`) is maintained by hand; nothing fetches rates from an external service. Converted
  prices in the frontend (shown as "≈") and price filters with `convertCurrency=true` are only as
  current as the file. To update: edit the rates and `asOf`, deploy, then run
  `open-estate-admin reload` (the Lambdas read the file at cold start; the frontend reads `/meta`
  on each page load). A scheduled updater (e.g. an EventBridge rule writing the file from a rates
  provider) is planned for later and not designed yet; it would need a licence-compatible source.
- **Converted price filters grow the query.** With `convertCurrency=true` the filter has one
  condition per configured currency (at most 31, `EXCHANGE_RATES_BOUNDS`); with DynamoDB that is
  a longer `FilterExpression` (4 KB limit), with OpenSearch a `bool.should`. Results are not sorted
  by converted price — the order stays `id` ascending.

## Data and import

- **Usage counting is at-least-once.** If one `ADD` of a batch fails, Lambda retries the whole
  batch and counters already written are counted twice.
- **Incomplete deletions are retried once.** If a listing's history still cannot be removed after
  the retry in `finalize`, the request stays `OPEN` and only the overdue notification (Req 9.5)
  prompts action; there is no automatic retry after that.
- **Run log marker.** `RunRejections` stores a marker item at `seq = 0` per run (connector, agency,
  start) and rejections from 1. This deviates from the design and must be kept in mind by anything
  reading the table directly.
- **Custom_Id import path untested in core.** Property 12 covers the import side of Req 12.14 only
  as a write through the shared writer; the "Identitätskonflikt" rejection is tested in ingestion.
- **Import mode default.** Records from connectors without `importMode` and without module default
  merge (`MERGE`); built-in modules default to `REPLACE`. Agencies editing imported listings of a
  built-in connector lose manual changes unless `importMode: "MERGE"` is set.

## Open tasks and housekeeping

- Optional tests still open: 5.3, 6.2, 6.4, 6.6, 6.8, 6.9, 8.2, 8.3, 10.2, 10.3, 10.6, 11.2, 11.7,
  11.8, 11.10, 12.4, 12.5, 14.5, 14.6, 14.10, 15.2, 16.1.
- `ROADMAP.md` is out of date: the v0.1–v1.0 items are done but unchecked, the MCP server is listed
  under ideas, and the listing management is missing.
- `tsconfig.tsbuildinfo` files are tracked in git and show up in every diff; untrack them and add
  them to `.gitignore`.
