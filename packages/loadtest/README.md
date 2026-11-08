# @open-estate/loadtest

Load test for the reference load (Req 2.4, 11.3): 100,000 listings, 50 req/s over 10 minutes,
measured separately for search (`GET /listings`, page size 20) and detail (`GET /listings/{id}`).
Acceptance: CloudWatch p95 of `RequestLatency` per endpoint ≤ 2 s (design, "Testing Strategy").

## 1. Test environment

Run against a dedicated test environment with the OpenSearch provider, never production. The
defaults of the WAF (2,000 requests per IP and 5 min) and of the Req 17 rate limit (60 requests per
60 s) block a single k6 machine at 50 req/s, so raise both for the test deployment:

```bash
npm run deploy --workspace @open-estate/infra -- \
  -c env=loadtest -c searchProvider=opensearch \
  -c wafRateLimit=50000 -c rateLimit='{"requests":10000,"windowSeconds":60}'
```

With API-key access enabled, create a key and pass it as `API_KEY` below.

## 2. Generate and seed 100,000 listings

```bash
npm run generate --workspace @open-estate/loadtest -- --env loadtest --region eu-central-1
```

| Flag            | Default       | Meaning                                                                             |
| --------------- | ------------- | ----------------------------------------------------------------------------------- |
| `--count`       | `100000`      | Number of listings                                                                  |
| `--seed`        | `1`           | Same seed → same listings and ids (re-seeding is idempotent)                        |
| `--out`         | –             | Also write the listings as JSONL (internal form, amounts in minor units)            |
| `--ids`         | `out/ids.txt` | Ids for the detail scenario (relative to `packages/loadtest`)                       |
| `--env`         | –             | Import into `OpenEstate-<env>`: stores from the `Data` and `ManagementData` outputs |
| `--concurrency` | `16`          | Listings imported in parallel                                                       |
| `--region`      | SDK default   | AWS region; credentials from the SDK chain (`AWS_PROFILE`, …)                       |

The connector Lambda's variables (`LISTINGS_TABLE_NAME`, `DUPLICATE_INDEX_TABLE_NAME`, …,
`CONFIG_BUCKET`) override single lookups. Listings are written through the import pipeline of the
connectors (the same code as `npm run seed`, source `loadtest`, `REPLACE`): with version, field
origins, counters, snapshot and the duplicate check, like imported listings. Taxonomy, allowlists
and duplicate rules come from the deployed config bucket. The DynamoDB stream indexes them into
OpenSearch. Wait until the indexer has caught up (indexer Lambda `IteratorAge` back at 0) before
starting k6. Each listing takes several writes plus the duplicate check, so 100,000 listings take
considerably longer than a plain batch write; raise `--concurrency` if the tables keep up.

Offer mix: a quarter each `SALE`, `RENT`, `SALE`+`RENT`, `RENT`+`SALE`. Cities come from
`src/cities.json`, types from the default taxonomy, prices in EUR, 1–6 rooms; the k6 search reads
the same files, so its filters return results. All listings use source `loadtest` and ids
`loadtest-<seed>-<index>`.

## 3. Run k6

```bash
cd packages/loadtest
export BASE_URL=https://<api-id>.execute-api.<region>.amazonaws.com/<stage>
npm run k6:search    # 10 min search
npm run k6:detail    # 10 min detail (ids from out/ids.txt, override with -e IDS_FILE=...)
npm run k6:all       # both, one after the other with a 30 s pause
```

k6 is not an npm dependency (`nix shell nixpkgs#k6`). Env: `BASE_URL`, `API_KEY` (sent as
`Authorization: Bearer`), `SCENARIO` (`search` | `detail` | `all`), `RATE` (default 50),
`DURATION` (default `10m`), `IDS_FILE`. A short smoke run: `-e RATE=5 -e DURATION=30s`.

## 4. Interpret the results

- **Acceptance signal:** CloudWatch metric `RequestLatency` (dimensions `interface=api`,
  `endpoint=search` / `detail`), statistic `p95`, period covering the 10-minute window of the
  respective run. Pass if ≤ 2,000 ms for each endpoint.
- **k6 thresholds** (`http_req_duration{scenario:…}` p95 ≤ 2 s, `checks` > 99 % status 200) are
  a client-side cross-check; they include network latency from the k6 machine, so a failure there
  with a passing CloudWatch p95 points to the client side.
- `dropped_iterations` > 0 means k6 could not hold 50 req/s (too few VUs or a slow client); the
  run then does not represent the reference load.
- Non-200 checks: 429 → WAF or rate limit not raised; 404 on detail → ids file from another seed
  or the table was not seeded.

## 5. Duplicate detection

Two targets of the duplicate detection (`.kiro/specs/duplicate-detection/`):

- **Creation:** the duplicate check adds at most 300 ms at p95 to `POST /listings` when a listing
  meets 200 candidates (Req 5.7).
- **Daily check:** a run over 1,000,000 listings ends within 4 hours (Req 10.9).

### Creation latency

```bash
npm run generate:duplicates --workspace @open-estate/loadtest   # → out/duplicates/*.json
```

| File            | Bodies | Purpose                                                                      |
| --------------- | ------ | ---------------------------------------------------------------------------- |
| `crowd.json`    | 250    | Listings in one 0.001° geo cell, each with its own house number (no duplicates) |
| `probe.json`    | 300    | Measured creations inside the crowd: each meets ≥ 200 candidates (the limit) |
| `isolated.json` | 300    | The same creations far apart in their own postal codes: no candidate         |

Create a machine access with `listing:write` for an agency of the test environment (portal → agency
→ machine access), then:

```bash
cd packages/loadtest
export MANAGEMENT_URL=https://<id>.execute-api.<region>.amazonaws.com/v1
export TOKEN=oem_<keyId>_<secret>
k6 run -e BODIES_FILE=../out/duplicates/crowd.json k6/management-create.js     # build the crowd
k6 run -e BODIES_FILE=../out/duplicates/isolated.json k6/management-create.js  # baseline
k6 run -e BODIES_FILE=../out/duplicates/probe.json k6/management-create.js     # 200 candidates
```

`RATE` (default 5/s) stays below the actor rate limit of the Management_API; `DURATION` defaults
to one pass over the file. All creations are stored `INACTIVE` and none is flagged. Compare the
p95 of the API Gateway metric `IntegrationLatency` (namespace `AWS/ApiGateway`, API
`OpenEstate-<env>-Management-management`) over the windows of the baseline and the probe run, or
the k6 `http_req_duration` p95 of both runs: the difference is the additional latency of the
duplicate check and must be ≤ 300 ms. Remove the test listings with a deletion request of the
agency's data source afterwards (`POST /platform/deletions`).

### Throughput of the daily check

A run has three phases that go over every listing (INDEX, ORPHAN, MATCH) in `sweep.segments`
(default 8) parallel parts. 1,000,000 listings in 4 hours need
`requiredSegmentRate(1_000_000, 8, 4)` ≈ 26 listings per second per part and phase. Start a run on
the test environment (`POST /platform/duplicate-sweeps`, or "Run duplicate check now" in the
admin mode) and read its log line (`"event":"duplicate.sweep"`, log group of the
`DuplicateSweepFunction`): `checked / (endedAt − startedAt) / segments` ÷ 3 must be at least that
rate; otherwise raise `sweep.segments` (up to 64) in `duplicate-detection.json`.
