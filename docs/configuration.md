# Configuration

Open Estate is configured with JSON files. You don't change application code to rebrand the frontend,
add a language, extend the property taxonomy, allow a 3D tour provider or set exchange rates. This
page covers those areas, plus the rules of the duplicate detection. Connector configuration
(`connectors.json`, `pii-allowlist.json`, `crawler-allowlist.json`) is described in
[connectors.md](connectors.md).

| File                                                  | Read by                                                    | Takes effect                                    |
| ----------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------- |
| `packages/frontend/public/theme-config.json`          | Frontend                                                   | Deploy, then reload the page                    |
| `packages/frontend/public/i18n-config.json`           | Frontend; mirrored to API, MCP, connectors                 | Deploy (frontend); reload (Lambda)              |
| `packages/frontend/public/i18n/<locale>.json`         | Frontend                                                   | Deploy, then reload the page                    |
| `packages/shared/src/config/taxonomy.json`            | API, MCP, connectors, Management API; frontend via `/meta` | Deploy, then reload (Lambda)                    |
| `packages/shared/src/config/tour-providers.json`      | API, MCP, connectors, Management API; CSP of the frontend  | Deploy, then reload (Lambda)                    |
| `packages/shared/src/config/exchange-rates.json`      | API, MCP; frontend via `/meta`                             | Deploy, then reload (Lambda)                    |
| `packages/shared/src/config/duplicate-detection.json` | Management API, connectors, daily duplicate check          | See [Duplicate detection](#duplicate-detection) |

## Applying changes

All configuration files are validated during `cdk synth`. If a file is invalid, synth fails and lists
every problem, so nothing is deployed. You don't need an Angular rebuild for any of these files: the
FrontendStack uploads the frontend files straight from their source directory. You do need an
existing build output (`packages/frontend/dist/browser`), because synth checks that it exists. Run
`npm run build` once after cloning.

```bash
npm run build                                              # once; only needed if dist/ is missing
npm run deploy --workspace @open-estate/infra -- -c env=prod
```

The frontend serves `index.html`, `theme-config.json`, `i18n-config.json` and `i18n/*` with
`Cache-Control: no-cache`, and each deploy invalidates them in CloudFront. Changes show up the next
time a user loads the page (Req 8.2).

API, MCP, connector and Management API Lambdas load the taxonomy, the locale list, the tour
allowlist and the duplicate rules only once, when an execution environment starts (cold start). A
deploy uploads the new files to the config bucket, but it does not restart running instances. To
restart the Lambdas that read these files, run `open-estate-admin reload` (see
[packages/admin/README.md](../packages/admin/README.md#reload)) or, as Plattform_Admin, use
`POST /platform/reload` of the Management API. The ManagementStack output `ReloadFunctionNames`
lists those functions (the administrator needs the `ReloadPolicyArn` policy of that stack for the
Management API itself):

```bash
export OPEN_ESTATE_RELOAD_FUNCTIONS=$(aws cloudformation describe-stacks \
  --stack-name OpenEstate-prod-Management \
  --query "Stacks[0].Outputs[?OutputKey=='ReloadFunctionNames'].OutputValue" --output text)
npx open-estate-admin reload
```

### Keeping your configuration outside the repository

Two CDK context values point synth at your own files. Relative paths resolve against the working
directory, which is `packages/infra` when you use `npm run … --workspace`, so use absolute paths:

- `-c configDir=<dir>` replaces `packages/shared/src/config` completely. The directory must contain
  `taxonomy.json`. It may also contain `tour-providers.json`, `exchange-rates.json` and the
  connector files. Unknown files
  are rejected. It must not contain `i18n-config.json`, which is mirrored from the frontend (see
  below).
- `-c i18nConfigFile=<dir>/i18n-config.json` replaces the frontend's `public/` files. The
  `theme-config.json` and the `i18n/` directory next to this file are used.

```bash
npm run deploy --workspace @open-estate/infra -- -c env=prod \
  -c configDir=/srv/open-estate/config \
  -c i18nConfigFile=/srv/open-estate/frontend/i18n-config.json
```

Uploads to the config bucket never delete anything (`prune: false`). If you remove a file from
`configDir`, the copy already in the bucket stays. To turn something off, change the file's content
instead (for example `{ "providers": [] }`).

## Theming

`theme-config.json` sets the logo, the brand colours and the localized app title (Req 8.1). The
frontend checks each value on its own:

- A missing value uses the default below and is not reported.
- An invalid value also uses the default and is logged once in the browser console:
  `[theme] invalid value, using default {path, reason}`. The log contains the path, never the value.
- Valid values are always used, even if other values in the file are invalid (Req 8.3–8.5).

If the file is missing or isn't a JSON object, all defaults apply. Defaults and rules come from
`THEME_DEFAULTS` in `packages/frontend/src/app/theme/resolve-theme.ts`.

| Key                       | Format                                           | Default       | Used for                                    |
| ------------------------- | ------------------------------------------------ | ------------- | ------------------------------------------- |
| `logoUrl`                 | Relative or `https://` URL, see below            | `logo.svg`    | Header logo (decorative, next to the title) |
| `colors.primary`          | Hex colour `#RRGGBB` or `#RGB`, case-insensitive | `#12352B`     | Dark theme: CSS property `--brand-primary`  |
| `colors.secondary`        | Hex colour `#RRGGBB` or `#RGB`, case-insensitive | `#A7E3C4`     | Dark theme: `--brand-secondary` (accent)    |
| `colors.light.primary`    | Hex colour, derived from `colors.primary`        | `#12352B`     | Light theme: `--brand-light-primary`        |
| `colors.light.secondary`  | Hex colour, derived from `colors.secondary`      | `#A7E3C4`     | Light theme: `--brand-light-secondary`      |
| `texts.appTitle.<locale>` | Non-empty text, at most 120 characters (trimmed) | `Open Estate` | Header title and `document.title`           |

`logoUrl` is either a relative URL (same origin, e.g. `logo.svg` or `/brand/logo.png`) or an absolute
`https://` URL with a host, at most 2,048 characters. Not allowed: whitespace, control characters,
`\`, protocol-relative `//host`, and any other scheme (`http:`, `data:`, `javascript:` …).

If `colors` or `texts` is present but isn't an object, the whole group is invalid. Localized texts
are resolved in this order (Req 8.7):

1. The entry for the active locale.
2. The entry for the default locale from `i18n-config.json`.
3. The default from the table above.

Every invalid locale entry is reported, whichever locale is active.

```json
{
  "logoUrl": "https://cdn.example.com/acme/logo.svg",
  "colors": { "primary": "#1D3557", "secondary": "#F1C40F" },
  "texts": {
    "appTitle": { "en": "Acme Homes", "de": "Acme Immobilien", "th": "Acme บ้าน" }
  }
}
```

### Light and dark theme

The header has a theme switch: *System* (the default, follows the operating system's
`prefers-color-scheme`), *Light* and *Dark*. The choice is stored like the language
(`localStorage` key `open-estate.theme`). A small inline script in `index.html` sets
`data-theme="light|dark"` and `color-scheme` on `<html>` before the first paint, so there is no
flash of the wrong theme; the FrontendStack allows exactly this script in the CSP by its SHA-256
hash. Both themes are sets of CSS custom properties in `src/styles.scss`
(`:root[data-theme='dark']`, `:root[data-theme='light']`); components use only these semantic
tokens (`--color-text`, `--color-surface`, `--color-accent`, …), never fixed colours.

`theme-config.json` stays backward compatible: `colors.primary` and `colors.secondary` are the
**dark** palette, as before. `colors.light` is optional and has the same two keys:

- In the dark theme `secondary` is the accent on the dark background (buttons, links, focus rings,
  selected chips) and `primary` the deep brand colour.
- In the light theme `light.primary` is the accent on the light background (fills, links, focus
  rings) and `light.secondary` the text on those fills.

Each missing light value is derived from the dark palette: `light.primary` is `colors.primary`,
darkened until it has a contrast of at least 4.5:1 on the light page background (`#F4EFE6`);
`light.secondary` is `colors.secondary` if it has 4.5:1 on `light.primary`, otherwise white
(`deriveLightPalette` in `resolve-theme.ts`). Explicit light values are used as given — check their
contrast yourself.

```json
{
  "colors": {
    "primary": "#1D3557",
    "secondary": "#F1C40F",
    "light": { "primary": "#1D3557", "secondary": "#FFF4C2" }
  }
}
```

In the light theme the hero image keeps its colours but fades into the light page at the top and
behind the search card; after a search the page uses a light surface instead of the dark overlay.

There are two ways to host the logo:

- On any `https://` host. The CSP allows `img-src https:`.
- In `packages/frontend/public/`. Build artifacts are uploaded with a one-year `immutable` cache
  header, and a file in `public/` is one of them. So use a new file name for every logo change, and
  run `npm run build` before deploying.

To apply a theme change, deploy (see [Applying changes](#applying-changes)). For a quick change
without a deploy, upload `theme-config.json` to the frontend bucket with
`--cache-control no-cache`. The next deploy overwrites it with the source file.

### Start page background (hero)

The start page shows `packages/frontend/public/hero-background.*` full-screen: AVIF and WebP for
browsers that support them, a palette-reduced PNG as fallback (`image-set()` in
`packages/frontend/src/styles.scss`). The image is not part of `theme-config.json`; to brand it:

- Replace the three files (same motif, 16:9, about 1672×941). Keep the composition of the
  default: buildings at the left and right edges, an empty middle for the search card. The image
  is drawn with `background-size: cover`, centred, so on screens wider than 16:9 only the top and
  bottom are cropped; on phones it shifts to the right edge (villa side).
- Or set the CSS custom property `--hero-background` in a deployment stylesheet, e.g.
  `:root { --hero-background: url('/brand/hero.webp'); }`.
- Produce the compressed variants with any optimizer, e.g. `cwebp -q 80`, `avifenc -q 60` and
  `magick in.png -colors 256 PNG8:hero-background.png`. No npm dependency is needed.

Because `public/` files get a one-year `immutable` cache header, prefer new file names for a new
image (and update the `image-set()` URLs); browsers that cached an old file under the same name
keep showing it.

After a search the same background stays behind a dark green overlay (a light surface in the light
theme); the search card moves into
the sticky header (animated with view transitions, skipped for `prefers-reduced-motion`).

## Search filters

The public search has a lean main bar — offer type, city, property group, price and the rooms
chips (`roomsMin`: Any, 1+ … 5+) — and a **More filters** view (drawer, full-screen sheet on phones)
with the remaining filters: living area (`areaMin`/`areaMax`), maximum rooms (`roomsMax`), postal
code (`postalCode`) and 3D tour (`hasTour`). A badge on the button counts the active extra filters.
A search is part of the URL (`/?offerType=SALE&city=Berlin&hasTour=true`), so it can be shared;
the query parameters are the `GET /listings` parameter names. The header's country stays a
separate, remembered choice (`?country=XX` preselects it).

### Adding a filter to More filters

The view is rendered from a declarative registry,
`packages/frontend/src/app/search/filters/extra-filters.ts`. Each entry has an `id`, a `labelKey`
(optional `hintKey`), a `kind` and the form field(s) it binds:

- `toggle` — one boolean field, e.g. `hasTour`;
- `text` — one text field with `maxLength` (optional `inputMode`, `autocomplete`, `placeholderKey`);
- `number` — one decimal field (optional `unitKey`);
- `number-range` — a `min`/`max` pair of decimal fields;
- `select` — one field with `choices(meta)` from `/meta` and an `anyLabelKey`, shown with the
  shared `oe-select` dropdown.

The field names are the URL query parameters and the Search_API parameters. Badge count, Reset,
URL mapping and validation follow from the entry: the shared `SearchQuery` schema validates every
field (bounds, Min ≤ Max, known codes), and an optional `validate(values)` adds frontend-only
rules. To add a filter:

1. Make sure the Search_API supports it (`SearchQuery` in `packages/shared/src/schema/search.ts`).
   The frontend must not offer filters the API ignores; new backend filters are a separate change.
2. If the field is new to the form, add it to `SearchFormValues`, `INITIAL_SEARCH_FORM_VALUES` and
   `SEARCH_FORM_FIELDS` in `validate-search-form.ts` (and map it in `toRawQuery`).
3. Append the definition to `EXTRA_FILTERS` and add its translation keys to every
   `i18n/<locale>.json` (the key-parity and template-i18n tests fail otherwise).

`test/filter-registry.test.ts` checks that ids and fields are unique and that every form field
belongs to either the main bar or the registry.

## Translations & locales

### `i18n-config.json`

```json
{
  "defaultLocale": "en",
  "enabled": [
    { "locale": "en", "label": "English" },
    { "locale": "de", "label": "Deutsch" },
    { "locale": "fr", "label": "Français" }
  ]
}
```

- `locale`: a BCP 47 tag of at most 35 characters. Tags must be unique; the check ignores case.
- `label`: a non-empty name for the language selector. Write it in the language itself.
- `defaultLocale`: must be one of the enabled locales, spelled exactly as in `enabled`.

The file has two consumers. The SPA loads it at startup. The DataStack also mirrors the same file into
the private config bucket. There, the API, MCP and connector Lambdas read it at cold start:

- `/meta` returns it under `locales`.
- `/openapi.json` lists the enabled locales: the `EnabledLocale` schema, the `lang` description and
  `x-enabled-locales`.

The API doesn't reject other `lang` values. Listing texts come from the language versions that the
connectors deliver, with a fallback to the best match. After you change the file, deploy and then run
`open-estate-admin reload` so that API and MCP report the new list.

### Translation files `i18n/<locale>.json`

Each enabled locale needs a file whose name is the locale exactly as configured, e.g. `i18n/fr.json`.
The file is a flat JSON object that maps translation keys to strings. Keys contain dots but aren't
nested. Values must be strings. Transloco parameters use `{{name}}`:

```json
{
  "home.title": "Trouvez votre prochain logement",
  "startup.error.defaultLocale": "Le fichier de traduction de la langue par défaut « {{locale}} » est absent ou invalide.",
  "offerType.SALE": "À vendre",
  "taxonomy.group.house": "Maison",
  "taxonomy.type.villa": "Villa"
}
```

Use `i18n/en.json` as the complete key list.

Synth checks the files:

- If the default locale's file is missing or invalid, synth fails with a message like this one
  (Req 13.9; the SPA would refuse to start in the same case):

  ```text
  Invalid frontend configuration:
    - translation file of the default locale "en": missing …/public/i18n/en.json
  ```

- If another enabled locale's file is missing or invalid, synth only warns
  (`open-estate:frontend-config`). The SPA then hides that locale (Req 13.12).

### Locale selection and fallback

At startup the SPA picks the active locale from the locales that are enabled and have a readable
file:

1. The stored choice (`localStorage` key `open-estate.locale`).
2. Otherwise, the first entry of the browser's `navigator.languages` that matches an available
   locale, either exactly (case-insensitive) or by its primary language. For example, `de-AT`
   selects `de`. It doesn't work the other way round: browser `de` doesn't select an enabled
   `de-AT`.
3. Otherwise, `defaultLocale`.

Texts follow this fallback chain (Req 13.7, 13.8):

1. The active locale.
2. The default locale.
3. The key itself. For code labels (`offerType.*`, `taxonomy.group.*`, `taxonomy.type.*`), the bare
   code is shown instead.

Empty strings count as missing. Each missing (locale, key) pair is logged once:
`[i18n] missing translation {locale, key}`.

### Country selection

Next to the language selector, the header has a country filter: *All countries* plus every country
that has public listings (`GET /locations`), with the country names localized by the browser
(`Intl.DisplayNames`) — no translation keys are needed per country. The choice is stored like the
language (`localStorage` key `open-estate.country`); a start URL with `?country=<ISO 3166-1
alpha-2>` preselects a country. A stored country without listings falls back to *All countries*.
The city autocomplete of the search form suggests only cities of the selected country.

### Adding a locale

1. Copy `packages/frontend/public/i18n/en.json` to `i18n/<locale>.json` and translate every value,
   including the `taxonomy.*` labels.
2. Add `{ "locale": "<locale>", "label": "<native name>" }` to `enabled` in `i18n-config.json`.
3. Optional: add `<locale>` to `texts.appTitle` in `theme-config.json`.
4. Deploy, then run `open-estate-admin reload`.

Removing a locale from `enabled` hides it right away. The uploaded `i18n/<locale>.json` stays in the
bucket until you delete it.

To try a locale locally, run `npm start --workspace @open-estate/frontend`. The dev server serves
`public/` directly.

Code changes follow one rule: component templates must not contain literal visible text (Req 13.2).
`packages/frontend/scripts/check-template-i18n.mjs` enforces it and runs as part of `npm run test:full` (not the quick `npm test`). You
can also run it on its own:

```bash
node packages/frontend/scripts/check-template-i18n.mjs [--json] [file.ts|file.html ...]
```

## Property taxonomy

`taxonomy.json` defines the property groups and listing types (Req 15.1). Both are
language-neutral codes. The usual format nests each group's types inside the group:

```json
{
  "groups": [
    { "code": "apartment", "types": ["apartment_unit", "condominium", "penthouse", "loft"] },
    { "code": "house", "types": ["single_family", "villa", "terraced", "semi_detached", "chalet"] },
    { "code": "land", "types": ["building_plot"] },
    { "code": "commercial", "types": ["office", "retail"] },
    { "code": "hospitality", "types": ["hotel", "guesthouse"] }
  ]
}
```

A flat format is also accepted. The file counts as flat if it has a top-level `types` key. In this
format, each type references its group:

```json
{
  "groups": [{ "code": "house" }, { "code": "hospitality" }],
  "types": [
    { "code": "villa", "group": "house" },
    { "code": "hotel", "group": "hospitality" }
  ]
}
```

Rules (`validateTaxonomy` in `packages/shared/src/taxonomy.ts`; Req 15.4):

- **Structure:** objects are strict, so unknown keys are rejected.
- **`INVALID_CODE_LENGTH`:** every code is 1–64 characters long.
- **`DUPLICATE_CODE`:** every code is unique across all groups and types together. A type can't share
  a code with a group.
- **`UNKNOWN_GROUP`:** in the flat format, every type must reference a defined group. In the nested
  format, each type belongs to exactly one group by construction. A group with no types is allowed.
- **Case:** codes are case-sensitive. `Villa` and `villa` are different codes, and filters match
  exactly. Use lowercase `snake_case`, because codes appear in URLs and translation keys.

Synth (and, as a second line of defence, every Lambda init) reports every violation together:

```text
Invalid configuration in /srv/open-estate/config:
  - taxonomy.json: DUPLICATE_CODE "villa": Code "villa" is not unique across groups and types
  - taxonomy.json: UNKNOWN_GROUP "hotel": Type "hotel" references undefined group "lodging"
```

If an invalid taxonomy reaches the bucket some other way, for example by a manual upload, the affected
functions abort their init and log every violation. They don't serve requests until the taxonomy is
fixed.

After you deploy and reload, the codes are available everywhere (Req 15.3):

- **API:** valid values of the `group` and `types` filters, and the `PropertyGroup` / `ListingType`
  enums in `/openapi.json`.
- **`/meta`:** `taxonomy.groups` lists each group with its types, in file order.
- **MCP:** the `list_property_types` tool.
- **Frontend:** the search form's group and type options, which come from `/meta`.

Connectors accept only configured `listingType` codes. If you remove a type, imports reject listings
with that type from then on. Listings already stored keep the type, but the API omits their `group`,
and the type is no longer a valid filter.

Labels come from the translation files: `taxonomy.group.<code>` and `taxonomy.type.<code>` in every
locale. A missing label shows the code itself.

```json
{ "taxonomy.group.hospitality": "Hospitality", "taxonomy.type.hotel": "Hotel" }
```

### Property attributes per group

A group may list the optional [property attributes](api.md#property-attributes) its listings can
carry in `attributes`. Without `attributes`, a group allows all of them.

```json
{
  "groups": [
    {
      "code": "apartment",
      "types": ["apartment_unit", "condominium", "penthouse", "loft"],
      "attributes": ["address.unit", "floor", "totalFloors", "yearBuilt", "bedrooms", "bathrooms"]
    },
    { "code": "land", "types": ["building_plot"], "attributes": ["plotArea", "parcelId"] }
  ]
}
```

Allowed values: `address.unit`, `floor`, `totalFloors`, `yearBuilt`, `plotArea`, `bedrooms`,
`bathrooms`, `parcelId`; anything else is `UNKNOWN_ATTRIBUTE`, a code listed twice in one group
`DUPLICATE_ATTRIBUTE` (`address.houseNumber` is always allowed).
An attribute the listing type's group does not allow is dropped on every channel: the Management
API names it in `droppedFields` of its answer, connectors in the run log; the rest of the listing is
stored. `/meta` publishes the lists
(`taxonomy.groups[].attributes`), and the portal's listing form shows exactly the attributes of the
selected type's group. In the flat format, put `attributes` on the group objects.

## 3D tour providers

`tour-providers.json` is the allowlist of hosts that 3D tours may be embedded from. It is
default-deny: if the file is missing or `providers` is empty, no tour is accepted or embedded.

```json
{
  "providers": [
    { "code": "matterport", "hostnames": ["my.matterport.com"] },
    { "code": "kuula", "hostnames": ["kuula.co"] }
  ]
}
```

- **`code`:** 1–64 characters, unique. It is stored with each tour as `providerCode`.
- **`hostnames`:** at least one per provider. Each one is a bare ASCII host name of 1–253 characters
  (`A–Z a–z 0–9 . -`). Not allowed: a scheme, a port, a path or wildcards. Write IDNs in punycode.
  Host names are unique across all providers (the check ignores case).
- **Matching:** exact and case-insensitive. `kuula.co` does not cover `www.kuula.co`, so list every
  host you need.

The allowlist is enforced in four places:

1. **Import** (connector Lambdas): a tour whose URL isn't `https`, or whose host isn't on the list,
   is dropped on its own and logged with its URL. The listing itself is kept. The `providerCode` is
   always derived from the host; a value the connector delivers is ignored. A listing keeps at most
   10 tours.
2. **Search:** `hasTour=true` returns only listings with at least one tour on a host that is allowed
   now (the check runs per request). `hasTour=false` or no `hasTour` means no tour filter; it does
   not mean "without tour". With an empty allowlist, `hasTour=true` matches nothing.
3. **Frontend:** a tour is embedded only if its host is in `/meta.tourProviders` when the page is
   shown. All other tours are hidden and logged as `[tours] …`.
4. **CSP:** synth sets the frontend's `frame-src` to exactly `https://<host>` for every allowed host,
   or to `'none'` if there are none. CloudFront limits the policy to 1,783 characters, which leaves
   about 1,460 characters for all `https://<host>` entries together. If you exceed it, synth fails
   with `Content-Security-Policy would be ~N characters …`.

### Adding a provider

1. Add `{ "code": "<code>", "hostnames": ["<host>"] }` to `tour-providers.json`.
2. Deploy. This step is required, because the CSP `frame-src` exists only in the FrontendStack.
3. Run `open-estate-admin reload` so that import, search and `/meta` use the new list.

Tours that were dropped before the provider was added come back only when the listing is imported
again. If you remove a provider, its tours that are already stored disappear from `hasTour` results
and are no longer embedded.

## Exchange rates

`exchange-rates.json` holds static exchange rates. They are used in two places:

- **Display currency in the frontend.** Next to the country, the header has a currency selector:
  *Original currency* (the default, every price in the listing's own currency) or one of the
  configured currencies. With a currency selected, result cards and the detail view show the
  converted amount marked as approximate ("≈ 110.818 €") with the original amount below it. The
  choice is stored like the country (`localStorage` key `open-estate.currency`).
- **Price filter.** The price fields of the search use the selected currency, or `defaultCurrency`
  with *Original currency*; the unit next to the fields says which. The frontend sends
  `currency=<code>&convertCurrency=true`, so listings in other currencies match after conversion
  (see [`GET /listings`](api.md#get-listings)). Switching the display currency converts the
  entered bounds into the new currency. Searches in URLs carry `currency`, so a shared link keeps
  its meaning.

```json
{
  "base": "EUR",
  "asOf": "2026-11-01",
  "rates": { "CHF": 0.93, "GBP": 0.88, "THB": 37.9, "USD": 1.16 }
}
```

- `base`: ISO 4217 code; one unit of `base` is worth `rates[X]` units of `X`. It needs no entry
  in `rates` (if it has one, the rate must be `1`).
- `asOf`: the date the rates were taken (`YYYY-MM-DD`); shown in the frontend's tooltip.
- `rates`: at most 30 currencies besides the base, each a positive number. Unknown keys are
  rejected (`ExchangeRatesConfig` in `packages/shared/src/exchange-rates.ts`).

The file is optional. Without it `/meta` has no `exchangeRates`, the frontend offers only
*Original currency*, and price filters compare in one currency. Rates are never fetched from an
external service: update the file by hand, deploy and run `open-estate-admin reload` (see
[known issues](known-issues.md#search-api)).

## Duplicate detection

### Switching it on and off

The duplicate detection costs reads and writes on every listing write (candidate search, the
duplicate index) and a daily check that reads every listing. If that is too expensive for now,
switch it off; nothing is lost and it can be switched on again at any time. The value is the SSM
parameter `/open-estate/<env>/duplicate-detection` (`enabled` or `disabled`):

- **At deployment:** `-c duplicateDetection=disabled` (default `enabled`, see
  [installation](installation.md#configuration-overrides)). The deployment only writes the
  parameter when this value changes, so a value switched in the admin mode stays.
- **At runtime:** admin mode → **Operations** → **Duplicate detection** (switch, asks before
  switching off), or `PUT /platform/duplicate-detection` with `{"enabled": false}` (Plattform_Admin,
  `platform:operate`). Running functions apply it within 60 seconds; no reload, no deployment.
- **Local demo:** `DEV_DUPLICATE_DETECTION=disabled npm run dev` (see [local-demo.md](local-demo.md)).

While it is off:

- creations and changes through the Management API, the connectors, `npm run seed` and the
  load-test generator are stored as requested: no candidate search, no flag, a duplicate stays
  `ACTIVE`, and the duplicate index is not maintained (no writes);
- the daily check ends right after its start (logged with `"status":"SKIPPED"`), and
  `POST /platform/duplicate-sweeps` answers `409 DUPLICATE_DETECTION_DISABLED`;
- existing flags and reports across agencies stay visible; agencies can still release a flagged
  listing or dismiss its flag, and platform admins can dismiss reports;
- `Idempotency-Key` on `POST /listings` keeps working (it is independent of the check).

Switching it on in the admin mode (or with `PUT /platform/duplicate-detection`) starts a duplicate
check at once: it rebuilds the index from all listings and sets or removes every flag, so
duplicates created while the detection was off are flagged then — but stay online, because the
check never changes a status. Until that run has finished, creations are checked against the index
as it was when the detection was switched off. Switched on by a deployment instead, the next daily
run catches up.

### Rules

`duplicate-detection.json` holds the rules of the duplicate detection (how they work:
[Management API](management-api.md#duplicate-detection)). The file is optional; without it the
defaults below apply. Every key is optional, objects are strict (unknown keys are rejected), and
synth reports every invalid value (`DuplicateConfig` in `packages/shared/src/duplicates/config.ts`).

```json
{
  "threshold": 0.7,
  "maxCandidates": 200,
  "textNearHamming": 3,
  "geoNearMeters": 15,
  "tolerances": {
    "areaClosePercent": 2,
    "areaNearPercent": 5,
    "areaDiffersPercent": 10,
    "pricePercent": 5,
    "plotAreaClosePercent": 2,
    "plotAreaDiffersPercent": 5
  },
  "weights": { "SAME_ADDRESS": 0.35, "AREA_CLOSE": 0.2, "…": "…" },
  "normalization": {
    "streetSuffixes": { "str": ["strasse", "straße", "str"], "…": ["…"] },
    "unitNoiseWords": ["whg", "wohnung", "we", "einheit", "apt", "apartment", "flat", "unit", "nr", "no", "top"]
  },
  "sweep": { "timeUtc": "03:00", "segments": 8 }
}
```

| Key                   | Default                              | Range   | Meaning                                                                                                       |
| --------------------- | ------------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------- |
| `threshold`           | 0.7                                  | 0.05–1  | A pair with a location anchor is a duplicate from this value                                                  |
| `maxCandidates`       | 200                                  | 10–1000 | Listings compared per check at most; the most specific matches are kept                                       |
| `textNearHamming`     | 3                                    | 0–7     | Title/description signatures with at most this many different bits count as nearly equal                      |
| `geoNearMeters`       | 15                                   | 1–50    | Distance of `GEO_NEAR`; up to 50 m counts as `GEO_ANCHOR`                                                     |
| `tolerances.*Percent` | see above                            | 0–100   | Area, price and plot area tolerances; `areaClose ≤ areaNear ≤ areaDiffers`, `plotAreaClose ≤ plotAreaDiffers` |
| `weights.<REASON>`    | see [table](management-api.md#rules) | −1–1    | Weight of each reason except `EXACT`                                                                          |
| `normalization`       | German and English                   | –       | Street suffix spellings (canonical → aliases) and words ignored in unit designations                          |
| `sweep.timeUtc`       | `03:00`                              | HH:MM   | Start of the daily check (UTC)                                                                                |
| `sweep.segments`      | 8                                    | 1–64    | Parallel parts of the daily check; raise for very large stocks                                                |

When changes take effect:

- **Daily check:** reads the file at the start of every run, so changed rules apply to all
  listings with the next run (or start one: `POST /platform/duplicate-sweeps`, admin mode →
  "Duplicates across agencies"). Changes of `normalization` or `textNearHamming` make the run
  rebuild every stored profile.
- **Management API and connectors:** read the file when an execution environment starts. Run
  `open-estate-admin reload` or `POST /platform/reload`; both restart the connectors and the
  Management API.
- **`sweep.timeUtc`:** the schedule is created at synth time; a new time needs a deployment.

The defaults were calibrated with a catalog of realistic pairs
(`packages/shared/test/duplicates/calibration.test.ts`): reposts with a new text, typing variants,
price changes within 5 %, shared photos and parcels are duplicates; neighbouring house numbers,
other units or floors, other postal codes, sale versus rent, and equal flats without any location
anchor are not. Without unit or floor, identical flats at one address are reported as possible
duplicates. Run that test after changing weights or the threshold.

