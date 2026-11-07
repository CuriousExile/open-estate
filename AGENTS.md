# Notes for AI coding agents

OpenEstate is an npm-workspaces TypeScript monorepo (`packages/*`). Everything except deploying
runs offline: no AWS account, credentials or Docker needed. Node.js 22.22.3+ (`.nvmrc`).

## Start here

```bash
./run-everything.sh
```

It runs every check (install, lint, typecheck, build, all tests, CDK synth, local demo smoke test)
and fetches the right Node.js by itself if needed. It ends with `RESULT: OK` or `RESULT: FAILED`;
for a failed step, read `logs/run-everything/<step>.log`. The summary is in
`logs/run-everything/summary.md`. Run it once before you change anything (baseline) and once when
you are done. `SKIP` for integration tests (no Docker) and e2e tests (no AWS) is expected, not a
failure.

If `node -v` is older than 22.22.3, put the Node.js that the script downloaded on your `PATH`
before running other npm commands: `export PATH="$PWD/$(ls -d .tools/node-*/ | head -1)bin:$PATH"`.

## Setup for working on the code

```bash
npm ci
npm run build        # once, and after changing a package that another package imports at runtime
```

## Which tests to run

Run the smallest set that covers your change. Don't run the full suite after every edit.

1. While editing: the affected files or area.
   - `npm test -- <file or name>`, e.g. `npm test -- search-service`
   - `npm run test:<area>`, with area one of `shared`, `search`, `management`, `ingestion`,
     `platform`, `frontend`, `infra` (see `AREAS` in `jest.config.js` for the directories)
2. After a change spanning areas: `npm test` (quick tier, about 15 s on 8 cores).
3. Once at the end: `./run-everything.sh`.

Change `packages/infra` → also run `npm run test:infra`. Changes to `packages/shared` affect every
area, so run `npm test` for them.

Tests run against `src` (ts-jest), not `dist`, so they need no build. The build (`tsc -b`) is
needed for `npm run dev`, `npm run synth` and the CDK app.

## When a property test fails

fast-check tests use random inputs, so a failure can show up in one run and not the next. Don't
rerun until it passes. The failure message (and the `run-everything` output) shows a `seed` and
`path`; replay exactly that case:

```bash
OPEN_ESTATE_TEST_TIER=full OPEN_ESTATE_FC_SEED=<seed> OPEN_ESTATE_FC_PATH="<path>" npx jest <test file>
```

Then decide whether the product code or the test's expectation is wrong (check the design comments
in the code and `.kiro/specs/`), fix it, and replay again.

## Running the app

`npm run dev` (SPA + APIs) or `npm run dev:server` (APIs only, port 4310): in-memory, seeded demo
data, password-less local login. See `docs/local-demo.md`. Never expose it.

## Conventions

- See `CONTRIBUTING.md` (code standards, tests) and `.kiro/steering/commits.md` (commits).
- New test directory → add it to `AREAS` in `jest.config.js`, or the Jest config fails to load.
- Don't add suites to `FULL_ONLY` to hide failures; it is for slow suites already covered
  elsewhere.
- Integration (`*.integration.test.ts`, need DynamoDB Local and OpenSearch) and e2e
  (`*.e2e.test.ts`, need a deployed stack) suites skip themselves without their environment.
