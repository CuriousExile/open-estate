# Local demo without AWS

> **DEV ONLY — insecure.** The local demo has a login page **without passwords** (anyone who can
> reach it can sign in as any demo user), keeps all data in memory and is meant for demos and UI
> work on your own machine. It binds to `127.0.0.1` only. Never deploy or expose it.

`npm run dev` runs the whole platform on your machine: Search API, MCP server and Management API
(with all portal and admin routes) on in-memory stores with seeded demo data, a local OpenID
Connect provider in place of Cognito, and the Angular SPA via `ng serve`.

## Run it

Requires Node.js `^22.12.0` or `>=24` (Angular CLI) and an `npm ci`.

```bash
npm ci
npm run dev          # builds packages/devserver, starts the dev server and ng serve
```

Open <http://127.0.0.1:4200>. Stop with `Ctrl+C` (stops both processes). State is lost on
every restart; each start seeds the same demo data again. The dev server is compiled once at
start (no watch mode): after changing backend code or the seed data
(`packages/devserver/src/seed/`), restart `npm run dev`. Nothing needs to be deployed for that;
`ng serve` reloads frontend changes by itself.

`npm run dev:server` starts only the dev server (no Angular, works on Node 20).

### Ports and environment variables

Both `npm run dev` and `npm run dev:server` read these variables:

| Variable              | Default                                  | Meaning                                                  |
| --------------------- | ---------------------------------------- | -------------------------------------------------------- |
| `DEV_PORT`            | `4310`                                   | Port of the dev server (APIs, MCP, OIDC, demo images)    |
| `DEV_FRONTEND_PORT`   | `4200`                                   | Port of the SPA (`ng serve`)                             |
| `DEV_HOST`            | `127.0.0.1`                              | Interface of the dev server; loopback addresses only     |
| `DEV_FRONTEND_ORIGIN` | `http://127.0.0.1:<DEV_FRONTEND_PORT>`   | Only if the browser reaches the SPA under another origin |
| `DEV_QUIET`           | unset                                    | `1`: no request log                                      |
| `DEV_TEST_HOOKS`      | unset                                    | `1`: `POST /__test__/reset` re-seeds all state (browser tests) |

For example, to run a second demo next to one on the default ports:

```bash
DEV_PORT=5310 DEV_FRONTEND_PORT=5200 npm run dev    # SPA at http://127.0.0.1:5200
```

`npm run dev` validates the variables before anything starts and refuses equal ports. Nothing in
the SPA's dev setup contains a port. The `ng serve` proxy
([`packages/frontend/dev/proxy.local.mjs`](../packages/frontend/dev/proxy.local.mjs)) reads
`DEV_HOST` and `DEV_PORT`. The dev server generates the SPA's `runtime-config.json` (with its own
OIDC issuer), like the ManagementStack does in AWS. If you start `ng serve --configuration local`
yourself, set the same `DEV_PORT` (and `DEV_HOST`) as for the dev server, and pass
`--port <DEV_FRONTEND_PORT>`.

The URLs below use the default ports:

| What                 | URL                                                               |
| -------------------- | ----------------------------------------------------------------- |
| Frontend (SPA)       | <http://127.0.0.1:4200> (portal: `/portal`)                       |
| Search API           | `http://127.0.0.1:4310/api` — e.g. `/api/listings`, `/api/locations`, `/api/openapi.json` |
| MCP endpoint         | `http://127.0.0.1:4310/mcp` (`POST`, Streamable HTTP)             |
| Management API       | `http://127.0.0.1:4310/management` — e.g. `/management/openapi.json` |
| OIDC issuer          | `http://127.0.0.1:4310/oidc` (`/.well-known/openid-configuration`) |
| Overview             | `http://127.0.0.1:4310/` (JSON with URLs and users)               |
| Demo images          | `http://127.0.0.1:4310/demo-media/…` (see [Demo images](#demo-images)) |
| SPA runtime config   | `http://127.0.0.1:4310/runtime-config.json` (generated, see above) |

The SPA reaches `/api`, `/management`, `/mcp`, `/demo-media` and `/runtime-config.json` through
the `ng serve` proxy (`packages/frontend/dev/proxy.local.mjs`). The `local` build configuration
leaves out `public/runtime-config.json`; the deployed file stays untouched.

### Demo images

Listing media must be `https://` URLs, so the seed stores them under the reserved host
`https://demo-media.localhost/…`. The dev server serves them at `/demo-media/…` and rewrites that
origin in Search API and MCP responses to `http://127.0.0.1:4200/demo-media/…` (through the
proxy, i.e. same-origin for the SPA). Two kinds exist, both made in this repository, nothing is
downloaded:

- `/demo-media/art/<scene>-<time>-<palette>.svg` — generated illustrations
  (`packages/devserver/src/media/illustrations.ts`; scenes `house`, `townhouses`, `apartment`,
  `villa`, `loft`, `chalet`, `tower`, `interior`; times `day`, `golden`, `dusk`, `night`).
- `/demo-media/photos/<name>.webp` — crops of `packages/frontend/public/hero-background.png`
  (`packages/devserver/media/photos/`).

On purpose, Rostock (sale) has no images and München-Schwabing (rent) a broken image URL (it belongs
to the suspended agency, so it is public only after reactivating Alpenblick Makler), so the
placeholder shows. Management API responses keep the stored `https://demo-media.localhost` URLs
(the portal validates them with the listing schema), so images in the portal's public preview show
the placeholder.

## Demo users and login

Open `/portal`. The SPA redirects to the local login page (Authorization Code + PKCE, like with
Cognito); pick a user — there is no password.

| User                                 | Role           | Agency                         |
| ------------------------------------ | -------------- | ------------------------------ |
| `paula.platform@example.org`         | PLATFORM_ADMIN | — (admin mode)                 |
| `anna.admin@nordlicht.example.org`   | AGENCY_ADMIN   | Nordlicht Immobilien (active)  |
| `max.member@nordlicht.example.org`   | AGENCY_MEMBER  | Nordlicht Immobilien (active)  |
| `sepp.admin@alpenblick.example.org`  | AGENCY_ADMIN   | Alpenblick Makler (suspended → `403 AGENCY_SUSPENDED`) |

Members added in the team view appear on the login page immediately. The start-up output also
prints the credential of the seeded machine access `CRM-Sync (Demo)` of Nordlicht
(`Authorization: Bearer oem_…`), e.g. for `curl` calls against the Management API.

## What is seeded

- 2 agencies, 4 users (above), the taxonomy, tour providers and PII allow-list of
  `packages/shared/src/config/`, locales of `packages/frontend/public/i18n-config.json`.
- 17 listings (sale and rent, Germany, Austria and Thailand — Bangkok and Pattaya, so the country
  filter has a second country with listings): manual portal listings with Custom_Ids, a
  price reduction, a restored version and a status toggle; 4 listings of the CRM connector
  `nordlicht-crm` (origin `IMPORT`) with import versions and a portal edit on top (field
  provenance mixes `IMPORT` and `PORTAL`); drafts (`INACTIVE`) and the 3 listings of the suspended
  agency are not public. Every title starts with `[DEMO]` and every description with a demo
  marker. Austria only has listings of the suspended agency, so it is not offered as a country.
- 4 connector runs over the last three weeks (rejections with field names, one `FAILURE`), two
  machine accesses (one revoked), usage counters (detail views, search impressions) for the last
  14 days and the corresponding audit log.

## How it works

`packages/devserver` (a private workspace package, not part of any Lambda bundle or CDK stack)
wires the real routers and use cases of `api`, `mcp`, `management`, `admin` and `ingestion` on the
in-memory stores of `core`, and translates Node HTTP requests into API Gateway proxy events. All
three APIs share one state:

| In AWS                                | Locally                                                        |
| ------------------------------------- | -------------------------------------------------------------- |
| DynamoDB tables, S3 snapshots         | in-memory stores of `core` (`InMemory*`)                       |
| DynamoDB Streams → indexer → index    | search reads a projection of the current listings (immediate)  |
| Cognito User Pool, `aws-jwt-verify`   | local OIDC provider, RS256 key per process, dev token verifier |
| CloudWatch Logs → UsageAggregator     | usage lines are counted in-process                             |
| CloudWatch metrics and alarms         | **synthetic** series and alarms (deterministic fake values)    |
| Step Functions deletion workflow      | runs in-process                                                |
| `POST /platform/reload`               | reports three simulated functions as reloaded                  |
| Connectors (crawler, DB, API)         | not runnable; the seeded runs come from a built-in demo feed   |

Rate limits are high (10,000 requests per minute) and access caches are 5 s instead of 60 s, so
suspensions and role changes show up quickly.

## Demo script (about 10 minutes)

1. **Public search** — <http://127.0.0.1:4200>: search for `Hamburg` or filter *For rent*; switch
   the language to Deutsch. The listings of the suspended agency and the drafts do not appear.
   Pick *Thailand* in the country selector (top right, next to the language): the search re-runs
   with `country=TH`, and the choice is remembered (`localStorage`; `/?country=TH` preselects it).
   Type `pat` or `lub` into *City*: the suggestions come from `GET /api/locations` and only list
   cities of the selected country. Rooms take numbers only (`1`, `3.5`).
2. **Listing detail** — open a result (`/listings/{id}`): offers, key facts, original listing link,
   the image carousel; Rostock shows the image placeholder.
3. **Portal login** — open <http://127.0.0.1:4200/portal>, pick **Anna Albers**.
4. **Create a listing** — *Listings → New listing*, fill in title, offer, type, rooms, area, city.
   By default it is created `INACTIVE` and is not searchable.
5. **Activate** — *Activate* it in its workspace (or in the listing overview); search for its city
   in the public search: it appears immediately. While signed in, the public search lets you
   manage the agency's own listings (platform admins: all): *Deactivate* / *Activate* and *Edit*
   on the result cards, and *Manage this listing* above the listing detail.
6. **Edit** — change the price; the workspace shows version 3.
7. **History** — open `NL-BER-001` (Berlin-Mitte): history with portal versions of two users,
   the diff between versions, *Restore* an older version. `CRM-4711` (Winterhude) shows the field
   provenance: offers from the import, title from the portal.
8. **Monitoring** — listings by status, changes per channel, connector runs (*Show rejections*),
   usage charts.
9. **Team and machine access** — add a member by e-mail (it shows up on the login page); create a
   machine access and copy the one-time secret; the revoked old access is listed.
10. **Admin mode** — sign out, sign in as **Paula Plattform**, *Administration*: agencies (open
    Nordlicht → *Suspend agency …*: the confirmation shows the affected listings and users from the
    dry run; cancel), *Platform monitoring*
    (alarms, endpoints — synthetic; agency activity per day), *Operations*
    (deletion request dry run, API keys, access mode, reload).
11. **MCP** — call a tool with `curl`:

    ```bash
    curl -s http://127.0.0.1:4310/mcp \
      -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
      -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
           "params":{"name":"search_listings","arguments":{"city":"Berlin"}}}'
    ```

## Limitations

- No persistence, no real connectors or crawler, no e-mail invitations (invited users just exist).
- Platform latency, request and alarm figures are synthetic and unrelated to local traffic.
- The OIDC provider implements only what the SPA uses (discovery, JWKS, authorize, token with
  code and refresh token, logout redirect). It is not a conforming identity provider.
