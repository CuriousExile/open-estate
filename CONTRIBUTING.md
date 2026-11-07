# Contributing to OpenEstate

Thanks for your interest! This project is early, so feedback on the design is just as valuable as code.

## Ways to contribute

- **Report bugs** or **request features** via [GitHub Issues](https://github.com/CuriousExile/open-estate/issues) using the templates.
- **Build a connector** for a data source you have legal access to — see "Connectors" below.
- **Improve docs** — typos, unclear steps, missing examples.
- **Pick an issue** labeled `good first issue` or `help wanted`.

## Development workflow

1. Fork the repository and create a branch from `main`: `feat/<short-name>` or `fix/<short-name>`.
2. Make your change with tests (see below).
3. Run `./run-everything.sh` (all checks, one command) and make sure it ends with `RESULT: OK`.
4. Open a pull request and fill in the template.

Small, focused PRs get reviewed faster. For larger changes, open an issue first so we can agree on the approach.

## Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(ingestion): add rate limiter for crawler connector
fix(api): return 400 when priceMin > priceMax
docs: describe theme-config.json color formats
```

## Code standards

- TypeScript in strict mode; no `any` without a comment explaining why.
- No hard-coded endpoints, credentials or environment names — read them through `ConfigProvider`.
- Every API error uses the shared `ApiError` shape with a stable `code`.
- Keep the core free of source-specific logic; that belongs in connectors.

## Tests

- **Two tiers.** `npm test` is the quick tier for the edit-test loop: every area except `infra`, no
  integration or e2e suites, none of the suites in `FULL_ONLY` in [`jest.config.js`](jest.config.js),
  and every `fc.assert` capped at `OPEN_ESTATE_QUICK_RUNS` runs (default 10). `npm run test:full`
  (and CI) runs everything at the full run counts. Run it, or `npm run verify`, before you open a
  PR.
- **Areas.** Each test directory belongs to exactly one area (Jest project) in `AREAS` in
  `jest.config.js`: `npm run test:shared`, `test:search`, `test:management`, `test:ingestion`,
  `test:platform`, `test:frontend`, `test:infra`. If you add a test directory, add it to an area;
  the Jest config fails to load if a test file is outside every area.
- **Flagging a suite as full-only.** Add it to `FULL_ONLY` with a one-line reason. Do this only if
  it is slow *and* either covered by a faster check or tests tooling rather than product code.
  Never use it to hide a flaky or failing test.
- **Replaying a property-test failure.** Copy `seed` and `path` from the failure message and run
  `OPEN_ESTATE_TEST_TIER=full OPEN_ESTATE_FC_SEED=<seed> OPEN_ESTATE_FC_PATH="<path>" npx jest <file>`.
- Unit tests with Jest for concrete examples and edge cases.
- Property-based tests with [fast-check](https://github.com/dubzzz/fast-check) for the correctness properties in the [design](.kiro/specs/real-estate-platform/design.md). Run at least 100 iterations and tag each test:

  ```ts
  // Feature: real-estate-platform, Property 1: Konjunktive Filterung
  ```

- Tests must not need an AWS account — use in-memory fakes.
- Integration tests (`*.integration.test.ts`) run against [DynamoDB Local](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/DynamoDBLocal.html) and a local [OpenSearch](https://opensearch.org/) container. Each suite is skipped unless its endpoint (`DYNAMODB_ENDPOINT`, `OPENSEARCH_ENDPOINT`) is set; `npm run test:integration` sets both to the defaults below, so start both containers:

  ```sh
  docker run --rm -d --name dynamodb-local -p 8000:8000 amazon/dynamodb-local
  docker run --rm -d --name opensearch -p 9200:9200 -e discovery.type=single-node \
    -e DISABLE_SECURITY_PLUGIN=true -e OPENSEARCH_JAVA_OPTS="-Xms512m -Xmx512m" \
    opensearchproject/opensearch:2.19.2   # wait until http://localhost:9200 answers (~30 s)
  npm run test:integration   # defaults: http://localhost:8000, http://localhost:9200
  docker stop dynamodb-local opensearch
  ```

- End-to-end tests (`*.e2e.test.ts`) run against a deployed environment and are skipped unless `OPEN_ESTATE_E2E_ENV` is set; see [docs/installation.md](docs/installation.md#end-to-end-tests).

## Connectors

A connector implements `initialize`, `run` and `reportStatus` and emits raw records; the framework normalizes, validates and stores them. Connector PRs must:

- include tests with recorded or synthetic fixtures (no live network calls in CI),
- document required configuration values,
- **state the legal basis** for using the source (official API, license, written permission, open data). Crawler-based connectors for sites whose terms prohibit scraping will not be merged.

## License of contributions

By submitting a contribution you agree that it is licensed under the [Apache License 2.0](LICENSE), as described in section 5 of the license.
