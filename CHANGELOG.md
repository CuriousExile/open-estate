# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Project specification: requirements, design and implementation plan.
- Open-source project scaffolding: license, roadmap, contribution guidelines, code of conduct, security policy, issue and PR templates.
- Test tiers and areas: `npm test` is a quick tier (no `infra`, property tests capped at 10 runs), `npm run test:full` runs everything (CI), `npm run test:<area>` runs one functional area, `npm run verify` is the final check. `AGENTS.md` for AI coding agents.
- Playwright browser tests (`packages/browser-tests`, `npm run test:browser`) against the local demo on their own ports, part of `./run-everything.sh` (`SKIP` without a Chromium): public search (105 tests, desktop and a phone viewport), agency portal (58) and admin mode (32). State-changing tests run one at a time on a freshly reset demo. Bugs they found are listed in its README.
- Activating and deactivating listings (Req 6.2) in the portal: in the listing overview (per row) and in the workspace header; in admin mode for the listings of every agency. Signed-in agency users (their own listings) and platform admins (all) manage listings right from the public search: *Deactivate* / *Activate* and *Edit* on the result cards, and a *Manage this listing* bar above the listing detail (also on `/listings/{id}`); anonymous visitors cause no additional requests.
- Management API: `GET /listings?ids=<id>,…` looks up 1 to 50 listings at once (e.g. a page of search results) and returns those the caller may read; unknown ids and other agencies' listings are left out. The public search uses it once per result page for signed-in users.
- Local demo: `DEV_TEST_HOOKS=1` enables `POST /__test__/reset` (DEV ONLY), which replaces all state with a fresh seed.
- Local demo ports are configurable: `DEV_PORT` (dev server, default 4310) and the new `DEV_FRONTEND_PORT` (`ng serve`, default 4200), so a second demo (e.g. for browser tests) can run next to one on the default ports. The dev server now generates the SPA's local `runtime-config.json` with its own OIDC issuer, and the `ng serve` proxy (`dev/proxy.local.mjs`, was `proxy.local.json`) reads the same variables; `npm run dev` validates them up front.
- `./run-everything.sh`: one command that installs, lints, type-checks, builds, runs all tests, synthesizes the CDK stacks and smoke-tests the local demo, with a PASS/FAIL/SKIP summary; fetches the pinned Node.js if needed.

### Fixed

- Admin mode → Operations was unusable: an empty modal dialog covered the page on load (the template's safe navigation yields `null`, which the confirmation dialog took for a confirmation).
- Admin mode → Platform monitoring: the agency activity failed with "Some entries are invalid" for every period but 30 days (a daily metric was requested per hour); it is now always requested per day. The period and access-mode dropdowns showed their first option instead of the active one.
- Version history: "Portal ·User …" is "Portal · User …" again.
- Refused requests of users and machine accesses of a suspended agency are audited with the identified actor and agency (Req 2.8); before, the entry had no actor.
- Search results or a listing opened from them sometimes did not appear until the next mouse move or key press: the search page's `@defer` blocks waited for browser idle time, which a busy browser can withhold for seconds. They now render `on immediate` (still lazy chunks); a slow detail chunk shows "Loading listing …".
- Image carousel: `NG0950` (required input read too early) when a carousel appeared under a resting pointer; events before its first render are ignored now.
- `npm ci` failed with `E404`: the lockfile pinned releases the npm registry does not have (Angular 21.2.25 / CLI 21.2.26 and five AWS SDK packages at 3.1149.0). They are now pinned to the newest published release at or below the old pin that is still at least four weeks old: Angular 21.2.24 (CLI and build included), `@aws-sdk/client-cloudformation` and `client-cognito-identity-provider` 3.1143.0, `client-sns`, `client-ssm` and `lib-dynamodb` 3.1142.0. Only these entries (plus two exact dependencies of the older Angular CLI/build) changed in the lockfile; every package still exists once.
- Dry run of removing a Plattform_Admin could answer `LAST_PLATFORM_ADMIN` for an admin that a concurrent request had just removed; it now re-reads the membership (fast-check seed 713905340).

- `tsc -b` failed on a fresh checkout because `tsconfig.tsbuildinfo` files were committed without their `dist/`; build info now lives in `dist/` and is git-ignored.

### Changed

- Node.js `engines` set to `^22.12.0 || >=24.0.0` (was `>=20.19.0`, which the Angular CLI never supported); `.nvmrc` pins 22.21.0, the version the checks are tested with.
- Frontend on Angular 21.2 (was 22.2) and TypeScript 5.9 (was 6.0): Angular 22 refuses Node below 22.22.3, and Angular 21 needs TypeScript < 6.0. Templates no longer read `private` members.
- Every dependency pinned to a release at least four weeks old and the lockfile regenerated with `npm install --before=2026-10-10`, so `npm ci` works from registry mirrors that lack recent versions.
