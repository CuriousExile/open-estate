# Browser tests (Playwright)

End-to-end tests of the Angular SPA in a real browser, against the local demo
([docs/local-demo.md](../../docs/local-demo.md)): the real Search API and Management API, seeded
demo data, the local OIDC login, `ng serve`. No AWS, no Docker. Not to be confused with
`npm run test:e2e` (Jest suites against a deployed AWS stack).

Covered: the **public search** (`tests/search`, including managing listings from it when signed
in), the **agency portal** (`tests/portal`: sign-in and roles, listings with (de)activation,
workspace and history, team, machine access, monitoring, audit log) and **admin mode**
(`tests/admin`: agencies, all listings, platform monitoring, operations, platform audit log).

## Run

```bash
npm run test:browser:install   # once: Chromium for Playwright (downloads ~150 MB)
npm run test:browser           # starts its own demo on ports 5200/5310, runs all tests
```

Playwright builds and starts the demo itself (`scripts/dev.mjs` with `DEV_TEST_HOOKS=1`), on ports
that do not clash with `npm run dev` (4200/4310), and stops it afterwards. The first start takes
about 45 s (`ng serve` compiles the SPA).

```bash
npm run test:browser -- --project search             # one project (see below)
npm run test:browser -- --project portal --no-deps   # without running its dependencies first
npm run test:browser -- search/filters               # one file
npm run test:browser -- -g "More filters"            # by title
npm run test:browser -- --ui                         # Playwright UI mode
npx playwright show-report logs/playwright/report    # HTML report of the last run
```

| Variable                         | Default | Meaning                                                                                         |
| -------------------------------- | ------- | ----------------------------------------------------------------------------------------------- |
| `BROWSER_TEST_FRONTEND_PORT`     | `5200`  | Port of the SPA (`ng serve`) started for the tests                                              |
| `BROWSER_TEST_DEV_PORT`          | `5310`  | Port of the dev server started for the tests                                                    |
| `BROWSER_TEST_REUSE_SERVER`      | unset   | `1`: use a demo already running on these ports; it must run with `DEV_TEST_HOOKS=1`             |
| `PLAYWRIGHT_CHROMIUM_EXECUTABLE` | unset   | Chromium to use instead of Playwright's download (same major version as Playwright's, 156)      |
| `CI`                             | unset   | One retry with trace, `failOnFlakyTests`, `forbidOnly`, 2 workers                               |

`./run-everything.sh` runs the suite as step "Browser tests" on free ports, and reports `SKIP`
if no Chromium is installed. Failures leave screenshots and traces in `logs/playwright/results/`
(`npx playwright show-trace <trace.zip>`).

## Projects and state

The demo keeps all state in memory and all tests share one demo, so who may change what is fixed:

| Project         | Tests                                   | Runs                                  | May change                                      |
| --------------- | --------------------------------------- | ------------------------------------- | ----------------------------------------------- |
| `setup`         | `tests/setup`                           | first                                 | resets the demo to its seed                     |
| `search`        | `tests/search` (desktop)                | after `setup`, in parallel            | nothing (signing in is fine)                    |
| `search-mobile` | `tests/search`, `@mobile` and `@touch`  | after `setup`, in parallel            | nothing                                         |
| `portal`        | `tests/portal`, `tests/admin`           | after `setup`, in parallel            | only data it creates itself: unique names, never public |
| `serial`        | `**/*.serial.spec.ts` (all folders)     | after all others, one at a time       | anything — each test starts with `resetDemo()`  |

Rules of thumb for new tests:

- **Reads seeded data** → any project, but assert only what no parallel test changes (e.g. the
  number of *active* listings, not of inactive ones; specific audit entries, not totals).
- **Creates its own data** → `portal`, with `unique(testInfo)` names, and keep it out of the
  public search (create listings inactive).
- **Changes seeded data, publishes something, or changes platform settings** (restore, status,
  suspension, access mode, deletion, roles of seeded users) → a `*.serial.spec.ts` file with
  `test.beforeEach(({ request }) => resetDemo(request))`.

The reset is a DEV ONLY hook of the dev server (`POST /__test__/reset`, only with
`DEV_TEST_HOOKS=1`, see `packages/devserver/src/test-hooks.ts`): a fresh seed in about 100 ms.
Sessions end with it, so sign in after a reset.

## Conventions

- **Locators by role and accessible name** (`getByRole('button', { name: 'Search' })`), as users
  and assistive technology find controls; the suite runs with `locale: 'en-US'`. Only fall back
  to CSS where a control has no accessible handle.
- **Sign in like a user:** `signIn(page, USERS.anna, '/portal/…')` goes through the local login
  page (Code + PKCE). Tokens are in the tab's sessionStorage, so a second page signs in on its own.
  Demo users: `USERS.paula` (platform admin), `anna` (agency admin), `max` (agency member), `sepp`
  (suspended agency) in [`support/portal.ts`](support/portal.ts).
- **Expected data is written out** ([`support/demo-listings.ts`](support/demo-listings.ts), the
  constants in the portal specs), not derived from the seed: a change of the demo data fails
  visibly.
- **Browser errors fail the test.** The auto fixture in [`support/fixtures.ts`](support/fixtures.ts)
  collects `console.error` and uncaught exceptions. A test that provokes errors names them with
  `consoleGuard.allow(/…/)`; errors every page has today are listed in `KNOWN_NOISE`.
- **Known product bugs are not worked around** in the tests. A deterministic one is pinned with
  `test.fail(…)` and a reason (the run fails once it is fixed, so the marker gets removed).
- **Mocked responses only for states the demo cannot produce** (server errors, timeouts, more than
  one result page), with `page.route`.

## Bugs found and fixed

Each has a test that fails without the fix.

| Bug | Fix | Test |
| --- | --- | --- |
| Results or a clicked listing sometimes did not appear (bare `@defer` waits for browser idle time; ~2–8 % of clicks under load) | `@defer (on immediate)` in `search-page.component.ts`; "Loading listing …" for a slow chunk | `search/rendering.spec.ts` |
| `NG0950` when a carousel appeared under a resting pointer | `ImageCarouselComponent` ignores events before its first render | `search/rendering.spec.ts` |
| Operations page unusable: an empty modal dialog covered it on load (`?.` in the template yields `null`, taken for a confirmation) | `ConfirmDialogComponent` treats `null` as unset | `admin/operations.spec.ts` |
| Agency activity failed for every period but 30 days (hourly request for a daily metric → 400) | always requested per day, with a hint | `admin/monitoring.spec.ts` |
| Period and access-mode dropdowns showed the first option, not the active one (`[value]` before the `@for` options) | `[selected]` per option | `admin/monitoring.spec.ts` |
| Version history read "Portal ·User Max Meyer" | one span | `portal/workspace.spec.ts` |
| Refused requests of a suspended agency were audited without actor although it is known (Req 2.8) | the Authenticator names the identified caller for the audit | `admin/audit.spec.ts`, unit tests |

## Known issues found by these tests

| Issue | Effect | Where |
| --- | --- | --- |
| Access mode is write-only (no `GET`): the portal always shows "Open" after a reload | Admins cannot see the current mode | Management API, `admin-operations` |
| With "API keys required" the public SPA cannot search (it sends no key) and says "check the filters" | Misleading message; design open | `result-list-model.ts` |
| A user of a suspended agency sees "Account not available", not "Your agency is suspended" | The specific reason is known (`AGENCY_SUSPENDED`) but not shown | `portal-auth` / notice |
| "Per listing" usage table shows listing UUIDs, not titles | Hard to read | `agency-monitoring.component.ts` |
| One public listing is not marked `[DEMO]` | Portal edit of CRM-4711 sets a title without `markDemoContent` | `devserver/src/seed/seed.ts` (pinned with `test.fail`) |
| No favicon | `/favicon.ico` 404 on every page load | `frontend/src/index.html` (`KNOWN_NOISE`) |
| Skipped view transitions logged as errors | `AbortError: Transition was skipped` on every search in dev builds | Angular router + `app.config.ts` (`KNOWN_NOISE`) |
| Listing content keeps its language after a language switch | UI German, titles English until the next search (not required by Req 13.5) | `result-list.component.ts` |
| "Any" rooms chip too narrow in German | Text overflows the chip in the compact header at 1280/1920 px (font-dependent, not asserted) | search bar styles |
| "More filters" errors are not announced | Unlike the main bar (`role="alert"`), the dialog only links the message via `aria-describedby` | `more-filters.component.ts` |
| Runs and usage tables of the monitoring have no caption | Tables without accessible name | `agency-monitoring.component.ts` |

Not covered yet: screen reader output, axe scans, Firefox/WebKit, the production build, the theme
switch and white-label overrides, listing translations/images/tours in the form, the deletion
blocklist, API key revocation and limits, MCP.
