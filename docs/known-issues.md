# Known issues

Open concerns from implementing the listing management (agency portal, versioning, Management
API). Nothing here blocks the tests; each item should be decided or fixed before a release. The
specification lives in [`.kiro/specs/listing-management/`](../.kiro/specs/listing-management/).

## Not verified

- **No deployment.** No stack has been deployed. Synthesis is only covered by CDK assertion tests;
  the one-command deploy into an empty account (ROADMAP v1.0) is unverified, including the new
  stack order (Data → ManagementData → Api → Monitoring → Ingestion → Admin → Frontend → Identity →
  Management).
- **No browser or Cognito test.** The portal's login (Code + PKCE), guards, bearer interceptor and
  components have no runtime test, and nothing ran against a real Cognito user pool.
- **No integration tests** (task 16.1): role changes, suspensions and revocations within 60 s,
  visibility in DynamoDB and OpenSearch search, deletion of versions and S3 snapshots, usage lines
  reaching the counters within 15 min.
- **Node version.** `package.json` allows Node ≥ 20.19, but the Angular CLI needs Node ≥ 22 and the
  AWS SDK warns that releases from January 2027 require Node 22. Raise `engines` and the CI image.

## Frontend

- **Bundle size.** The initial bundle is about 650 kB, under the 700 kB warning budget. The main
  parts are Angular (~395 kB incl. router and forms), `angular-auth-oidc-client` (~135 kB) and zod
  (~130 kB). The OIDC client cannot move into the lazy portal chunks: its services are
  `providedIn: 'root'` and need `StsConfigLoader` and the storage/logger tokens at root, and its
  bundle does not tree-shake, so any root import pulls all of it. zod stays small only with
  `import * as z from 'zod'` (enforced by lint) and `sideEffects: false` in shared.
- **Two diff views.** The listing form uses `portal/shared/diff-view`, the workspace its own
  `workspace/version-diff.component.ts`. Merge them.
- **`toPublicDetailModel`** lives in the workspace folder and mirrors the Search_API's
  serialization. If the Search_API changes how it picks the language version, the preview drifts
  silently; property test 14.6 is not written yet.

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
- **CORS lives in an infra wrapper** (`infra/src/lambda/management-cors.ts`) around the management
  handler, not in `packages/management`.
- **`runtime-config.json` is written by the ManagementStack**, not the FrontendStack. Deploying the
  frontend without the ManagementStack leaves the old file; a missing ManagementStack means no
  portal configuration.
- **CloudWatch reads use `*`** (`GetMetricData`, `ListMetrics`, `DescribeAlarms` have no resource
  scoping).

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
