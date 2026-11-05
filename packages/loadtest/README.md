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

| Flag       | Default       | Meaning                                                                  |
| ---------- | ------------- | ------------------------------------------------------------------------ |
| `--count`  | `100000`      | Number of listings                                                       |
| `--seed`   | `1`           | Same seed → same listings and ids (re-seeding overwrites, idempotent)    |
| `--out`    | –             | Also write the listings as JSONL (internal form, amounts in minor units) |
| `--ids`    | `out/ids.txt` | Ids for the detail scenario (relative to `packages/loadtest`)            |
| `--table`  | –             | Table name; else `LISTINGS_TABLE_NAME`, else output of `--env` stack     |
| `--env`    | –             | Environment of the stack `OpenEstate-<env>-Data` for the table lookup    |
| `--region` | SDK default   | AWS region; credentials from the SDK chain (`AWS_PROFILE`, …)            |

Listings are written with the infra seed writer (`toListingItem` + BatchWrite), so the layout is
identical to imported listings; the DynamoDB stream indexes them into OpenSearch. Wait until the
indexer has caught up (indexer Lambda `IteratorAge` back at 0) before starting k6.

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
