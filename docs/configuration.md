# Configuration

Open Estate is configured with JSON files. You don't change application code to rebrand the frontend,
add a language, extend the property taxonomy or allow a 3D tour provider. This page covers those four
areas. Connector configuration (`connectors.json`, `pii-allowlist.json`, `crawler-allowlist.json`)
is described in [connectors.md](connectors.md).

| File                                             | Read by                                    | Takes effect                       |
| ------------------------------------------------ | ------------------------------------------ | ---------------------------------- |
| `packages/frontend/public/theme-config.json`     | Frontend                                   | Deploy, then reload the page       |
| `packages/frontend/public/i18n-config.json`      | Frontend; mirrored to API, MCP, connectors | Deploy (frontend); reload (Lambda) |
| `packages/frontend/public/i18n/<locale>.json`    | Frontend                                   | Deploy, then reload the page       |
| `packages/shared/src/config/taxonomy.json`       | API, MCP, connectors; frontend via `/meta` | Deploy, then reload (Lambda)       |
| `packages/shared/src/config/tour-providers.json` | API, MCP, connectors; CSP of the frontend  | Deploy, then reload (Lambda)       |

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

API, MCP and connector Lambdas load the taxonomy, the locale list and the tour allowlist only once,
when an execution environment starts (cold start). A deploy uploads the new files to the config
bucket, but it does not restart running instances. To restart the Lambdas that read these files,
run `open-estate-admin reload` (see [packages/admin/README.md](../packages/admin/README.md#reload)).
The AdminStack output `ReloadFunctionNames` lists those functions:

```bash
export OPEN_ESTATE_RELOAD_FUNCTIONS=$(aws cloudformation describe-stacks \
  --stack-name OpenEstate-prod-Admin \
  --query "Stacks[0].Outputs[?OutputKey=='ReloadFunctionNames'].OutputValue" --output text)
npx open-estate-admin reload
```

### Keeping your configuration outside the repository

Two CDK context values point synth at your own files. Relative paths resolve against the working
directory, which is `packages/infra` when you use `npm run … --workspace`, so use absolute paths:

- `-c configDir=<dir>` replaces `packages/shared/src/config` completely. The directory must contain
  `taxonomy.json`. It may also contain `tour-providers.json` and the connector files. Unknown files
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
| `colors.primary`          | Hex colour `#RRGGBB` or `#RGB`, case-insensitive | `#12352B`     | CSS property `--brand-primary`              |
| `colors.secondary`        | Hex colour `#RRGGBB` or `#RGB`, case-insensitive | `#A7E3C4`     | CSS property `--brand-secondary` (accents)  |
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

There are two ways to host the logo:

- On any `https://` host. The CSP allows `img-src https:`.
- In `packages/frontend/public/`. Build artifacts are uploaded with a one-year `immutable` cache
  header, and a file in `public/` is one of them. So use a new file name for every logo change, and
  run `npm run build` before deploying.

To apply a theme change, deploy (see [Applying changes](#applying-changes)). For a quick change
without a deploy, upload `theme-config.json` to the frontend bucket with
`--cache-control no-cache`. The next deploy overwrites it with the source file.

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
`packages/frontend/scripts/check-template-i18n.mjs` enforces it and runs as part of `npm test`. You
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
