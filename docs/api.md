# Search API

The Search API is a read-only JSON API over HTTPS. You can search listings, fetch one listing, and
read two discovery documents: an OpenAPI 3.1 description and a metadata document with the
configured taxonomy, languages and bounds. AI agents can use the same functions through the
[MCP server](mcp.md).

| Method | Path             | Purpose                                                                    |
| ------ | ---------------- | -------------------------------------------------------------------------- |
| `GET`  | `/listings`      | [Search listings](#get-listings) with filters, paged                       |
| `GET`  | `/listings/{id}` | [Get one listing](#get-listingsid) with all offers, media and tours        |
| `GET`  | `/openapi.json`  | [OpenAPI 3.1 document](#get-openapijson) (machine-readable API schema)     |
| `GET`  | `/meta`          | [Platform metadata](#get-meta): taxonomy, locales, currency, tours, bounds |
| `POST` | `/mcp`           | MCP server (JSON-RPC 2.0), see [mcp.md](mcp.md)                            |

All examples on this page are produced by the real handlers. The test
`packages/api/test/docs-examples.test.ts` runs every `curl` example against the handlers, using the
example data in `packages/api/test/support/docs-examples.ts`, and fails if a documented response no
longer matches. When you change the API, update the examples here (the test diff shows the new
output).

## Basics

### Base URL and stage

Every deployment has one API Gateway stage named after the environment (`-c env=<name>`, default
`dev`). The base URL is the `ApiUrl` output of the `OpenEstate-<env>-Api` stack and already ends with
the stage and a slash:

```sh
export API_URL=$(aws cloudformation describe-stacks --stack-name OpenEstate-dev-Api \
  --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" --output text)
echo "$API_URL"   # https://abc123defg.execute-api.eu-central-1.amazonaws.com/dev/
```

The examples below use `${API_URL}listings` and so on.

### Access modes and API keys

An operator chooses one of two access modes:

- `open` (the default). No credentials. The rate limit is counted per source IP address.
- `api-keys`. Every request to the Search API and the MCP server needs a valid key in the
  `Authorization` header. The rate limit is counted per key.

```sh
curl -sS -H "Authorization: Bearer $API_KEY" "${API_URL}listings?city=Berlin"
```

If the key is missing you get `401 API_KEY_MISSING`. If it is unknown, revoked or expired you get
`401 API_KEY_INVALID`. The discovery endpoints `/openapi.json` and `/meta` need a key too. Operators
manage keys and the mode with the admin CLI, for example `open-estate-admin create-key` and
`open-estate-admin set-access-mode api-keys`. The plaintext key is shown once, when it is created.
Access changes take effect within 60 seconds.

### Rate limiting

Each client gets a configurable number of requests per time window. The default is 60 requests per
60 seconds. A key can have its own limit. Requests to the Search API and to the MCP server count
against the same limit. When the limit is reached, the API answers `429 RATE_LIMITED` with the wait
time twice: in the `Retry-After` header and in `retryAfterSeconds` in the body (see the
[example](#429-rate-limited)). Wait that many seconds before you retry.

API Gateway and a WAF rule add coarse flood protection in front of the API. Their 429 answers use
the same error format. API Gateway throttling sends `Retry-After: 1`. The WAF rule sends no wait
time, so back off exponentially if `Retry-After` is missing.

### Languages

Listings have an original language and up to 20 translations. Every listing in a response carries
the title and description of one language version and says which one:

- `deliveredLocale` is the language of `title` and `description`.
- `originalLocale` is the language the listing was published in.

You choose the language with the `lang` query parameter (a BCP 47 tag such as `en` or `de-AT`) or
with the standard `Accept-Language` header. If both are present, `lang` wins and the header is
ignored. For each preferred language in order, the API picks the version with exactly that tag
(case-insensitive). If there is none, it picks a version with the same primary language, so `de-AT`
matches `de`. If nothing matches, you get the original version. Missing translations are not an
error. An invalid `lang` (empty, longer than 35 characters or not BCP 47) is rejected with
`400 INVALID_LOCALE`. An invalid `Accept-Language` header is never an error. Codes such as
`offerType`, `listingType` and `group` are language-neutral and never translated.

### Amounts and areas

Amounts (`price`, `coldRent`, `additionalCosts`, `warmRent`) and areas are decimal strings with at
most two fraction digits, for example `"450000.00"` or `"92.40"`. Amounts are in the unit of the
offer's `currency` (ISO 4217): 0.01 to 999,999,999.99. Areas are in m²: 1.00 to 100,000.00. Send
filter values the same way, for example `priceMax=1300` or `areaMin=60.5`. Numbers in JSON are used
only for `rooms` (0 to 99.5 in steps of 0.5) and `geo` coordinates.

### Offers

Every listing has one or two offers, at most one per offer type:

- `SALE`: `price`, `currency`.
- `RENT`: `coldRent` (the rent price), `currency`, optional `additionalCosts` and `warmRent`
  (`warmRent` ≥ `coldRent`).

A listing that you can buy or rent has both offers, like `berlin-mitte-0042` in the examples.

### CORS

Browsers may read responses only from the deployment's frontend origin and from the origins in the
CDK context `corsAllowedOrigins`. The API never sends `Access-Control-Allow-Origin: *` and never
allows credentials. Simple `GET` requests need no preflight. With `Authorization` (API-key mode),
browsers send a preflight first:

```sh request:preflight
curl -sS -i -X OPTIONS \
  -H "Origin: https://estate.example.org" \
  -H "Access-Control-Request-Method: GET" \
  -H "Access-Control-Request-Headers: authorization" \
  "${API_URL}listings"
```

```http head:preflight
HTTP/1.1 204 No Content
Vary: Origin
Access-Control-Allow-Origin: https://estate.example.org
Access-Control-Allow-Methods: GET
Access-Control-Allow-Headers: Authorization, Accept-Language
Access-Control-Max-Age: 3600
```

Every response carries `Vary: Origin`. Responses to allowed origins also carry
`Access-Control-Expose-Headers: Retry-After`. The MCP endpoint is for agents, not browsers, and has
no CORS. The response headers shown on this page are the ones the API sets. API Gateway adds its own
(`Date`, `x-amzn-RequestId`, …).

## `GET /listings`

Searches listings. All filters are optional and combined with AND. Without filters you get all
listings.

| Parameter    | Type                     | Allowed values                              | Description                                                                                      |
| ------------ | ------------------------ | ------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `offerType`  | enum                     | `SALE`, `RENT`                              | Only listings with an offer of this type.                                                        |
| `priceMin`   | decimal string           | 0.01 – 999999999.99, ≤ 2 fraction digits    | Inclusive lower bound of the offer price (`coldRent` for `RENT`). Requires `offerType`.          |
| `priceMax`   | decimal string           | 0.01 – 999999999.99, ≤ 2 fraction digits    | Inclusive upper bound of the offer price (`coldRent` for `RENT`). Requires `offerType`.          |
| `currency`   | string                   | ISO 4217, `^[A-Z]{3}$`                      | Currency of `priceMin`/`priceMax`. Default: the deployment's `defaultCurrency` (see `/meta`).    |
| `roomsMin`   | number                   | 0 – 99.5, step 0.5                          | Inclusive lower bound of the number of rooms.                                                    |
| `roomsMax`   | number                   | 0 – 99.5, step 0.5                          | Inclusive upper bound of the number of rooms.                                                    |
| `areaMin`    | decimal string           | 1.00 – 100000.00 (m²), ≤ 2 fraction digits  | Inclusive lower bound of the living or plot area.                                                |
| `areaMax`    | decimal string           | 1.00 – 100000.00 (m²), ≤ 2 fraction digits  | Inclusive upper bound of the living or plot area.                                                |
| `city`       | string                   | 1 – 200 characters                          | Exact city name, case-insensitive.                                                               |
| `postalCode` | string                   | 1 – 10 characters                           | Exact postal code.                                                                               |
| `group`      | taxonomy group code      | exactly 1 code from `/meta`                 | Only listings whose type belongs to this property group. Cannot be combined with `types`.        |
| `types`      | taxonomy type code, list | 1 – 50 codes from `/meta`                   | Only listings of one of these types (OR). Repeat the parameter: `types=loft&types=penthouse`.    |
| `hasTour`    | boolean                  | `true`, `false`                             | `true`: only listings with a 3D tour of an allowed tour provider. `false` means no tour filter.   |
| `lang`       | BCP 47 tag               | 1 – 35 characters                           | Preferred language; overrides `Accept-Language`. See [Languages](#languages).                    |
| `pageSize`   | integer                  | 1 – 50, default 20                          | Number of listings per page.                                                                     |
| `pageToken`  | string                   | 1 – 1024 characters                         | `nextPageToken` of the previous page.                                                            |

The same table, with the configured enumerations, is in `GET /openapi.json`. The MCP tool
`search_listings` takes exactly these parameters as typed JSON values.

Filter rules:

- **AND.** A listing must match every filter you send. Range bounds are inclusive. `roomsMin` greater
  than `roomsMax` (and likewise for price and area) is `400 INVALID_RANGE`.
- **Group or types.** `group` is shorthand for all types of that group in the current taxonomy. Send
  either `group` or `types`, not both (`400 CONFLICTING_FILTERS`). An unknown code is
  `400 UNKNOWN_TAXONOMY_CODE`, one error per code. A wrong count (more than one `group`, zero or more
  than 50 `types`) is `400 INVALID_FILTER_COUNT`.
- **Price needs an offer type.** `priceMin`/`priceMax` apply to the offer of the given `offerType`:
  `price` for `SALE` and `coldRent` for `RENT`. A price bound without `offerType` is
  `400 OFFER_TYPE_REQUIRED`. Prices are compared in one currency, with no conversion: `currency`, or
  `defaultCurrency` if you leave it out. Offers in another currency don't match.
  `offerType=RENT&priceMax=1300` finds listings that can be rented for at most 1,300 EUR cold rent,
  including listings that are also for sale.
- **Tours.** `hasTour=true` checks the tour hosts against the tour-provider allow-list that is
  current when you search (`tourProviders` in `/meta`).
- **Strict parameters.** Unknown parameters are ignored. Repeating a parameter other than `types` or
  `group` is an error for that parameter (for example `INVALID_PARAMETER` or `INVALID_PAGE_SIZE`).
  Every invalid parameter is reported, each in its own error with its `field`, and nothing is
  searched.

### Ordering and pagination

Results are always ordered by `id` ascending, so the same query returns the same order with every
provider. A response contains at most `pageSize` listings. If more listings match, the response has
a `nextPageToken`. Send it as `pageToken` together with the same filters and `pageSize` to get the
next page. The last page has no `nextPageToken`.

The token is opaque and tied to the query. With other filters or another `pageSize` you get
`400 INVALID_PAGE_TOKEN`. Only `lang` and `Accept-Language` may change between pages. Paging uses
the last `id` as a keyset, so listings that are added or removed while you page never cause
duplicates.

### Example: search

Apartments in Berlin, one per page, in English:

```sh request:search
curl -sS -H "Accept-Language: en" \
  "${API_URL}listings?city=Berlin&group=apartment&pageSize=1"
```

```http head:search
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
Vary: Origin
```

```json response:search
{
  "items": [
    {
      "id": "berlin-mitte-0042",
      "title": "Bright 3.5-room period apartment with balcony in Mitte",
      "description": "Renovated period apartment on the 3rd floor with stucco, wooden floors and a south-facing balcony. Available to buy or to rent.",
      "deliveredLocale": "en",
      "originalLocale": "de",
      "offers": [
        { "offerType": "SALE", "price": "450000.00", "currency": "EUR" },
        {
          "offerType": "RENT",
          "coldRent": "1250.50",
          "currency": "EUR",
          "additionalCosts": "280.00",
          "warmRent": "1530.50"
        }
      ],
      "listingType": "apartment_unit",
      "group": "apartment",
      "rooms": 3.5,
      "area": "92.40",
      "address": {
        "city": "Berlin",
        "postalCode": "10115",
        "country": "DE",
        "street": "Invalidenstraße 12"
      },
      "geo": { "lat": 52.530644, "lon": 13.383068 },
      "sourceUrl": "https://partner.example/expose/berlin-mitte-0042",
      "media": [
        { "url": "https://media.partner.example/berlin-mitte-0042/living-room.jpg" },
        { "url": "https://media.partner.example/berlin-mitte-0042/balcony.jpg" }
      ],
      "tours": [
        { "url": "https://my.matterport.com/show/?m=Zh14WDtkjdC", "providerCode": "matterport" }
      ],
      "source": "example-partner",
      "lastImportedAt": "2026-11-05T03:00:12.000Z",
      "lastRunId": "run-20261105-0300"
    }
  ],
  "nextPageToken": "eyJ2IjoxLCJsYXN0SWQiOiJiZXJsaW4tbWl0dGUtMDA0MiIsInF1ZXJ5SGFzaCI6IjJmNTcxNTU0YjE4NDBmZmMxMTQ4ZDQxYTQxZWNjMjk0MzM5OTljMGJiYjY3NmRlM2EwNDBiNjkyN2NjNjYwNGMifQ"
}
```

The next page uses the same query plus `pageToken`. This listing has no English translation, so it
comes back in its original language (`deliveredLocale: "de"`). It is the last match, so there is no
`nextPageToken`:

```sh request:search-page-2
curl -sS -H "Accept-Language: en" \
  "${API_URL}listings?city=Berlin&group=apartment&pageSize=1&pageToken=eyJ2IjoxLCJsYXN0SWQiOiJiZXJsaW4tbWl0dGUtMDA0MiIsInF1ZXJ5SGFzaCI6IjJmNTcxNTU0YjE4NDBmZmMxMTQ4ZDQxYTQxZWNjMjk0MzM5OTljMGJiYjY3NmRlM2EwNDBiNjkyN2NjNjYwNGMifQ"
```

```http head:search-page-2
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
Vary: Origin
```

```json response:search-page-2
{
  "items": [
    {
      "id": "berlin-pankow-0107",
      "title": "2-Zimmer-Wohnung nahe Bürgerpark",
      "description": "Ruhige Wohnung mit Einbauküche, ab sofort frei.",
      "deliveredLocale": "de",
      "originalLocale": "de",
      "offers": [{ "offerType": "RENT", "coldRent": "980.00", "currency": "EUR" }],
      "listingType": "apartment_unit",
      "group": "apartment",
      "rooms": 2,
      "area": "61.00",
      "address": { "city": "Berlin", "postalCode": "13187", "country": "DE" },
      "sourceUrl": "https://partner.example/expose/berlin-pankow-0107",
      "media": [],
      "tours": [],
      "source": "example-partner",
      "lastImportedAt": "2026-11-05T03:00:12.000Z",
      "lastRunId": "run-20261105-0300"
    }
  ]
}
```

### Example: price and tour filter

Listings for rent at a cold rent of at most 1,300 in the default currency (EUR), with a 3D tour. The
Mitte apartment matches through its `RENT` offer, although it is also for sale. The Pankow apartment
has no tour:

```sh request:search-filtered
curl -sS "${API_URL}listings?offerType=RENT&priceMax=1300&hasTour=true&lang=en"
```

```http head:search-filtered
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
Vary: Origin
```

```json response:search-filtered
{
  "items": [
    {
      "id": "berlin-mitte-0042",
      "title": "Bright 3.5-room period apartment with balcony in Mitte",
      "description": "Renovated period apartment on the 3rd floor with stucco, wooden floors and a south-facing balcony. Available to buy or to rent.",
      "deliveredLocale": "en",
      "originalLocale": "de",
      "offers": [
        { "offerType": "SALE", "price": "450000.00", "currency": "EUR" },
        {
          "offerType": "RENT",
          "coldRent": "1250.50",
          "currency": "EUR",
          "additionalCosts": "280.00",
          "warmRent": "1530.50"
        }
      ],
      "listingType": "apartment_unit",
      "group": "apartment",
      "rooms": 3.5,
      "area": "92.40",
      "address": {
        "city": "Berlin",
        "postalCode": "10115",
        "country": "DE",
        "street": "Invalidenstraße 12"
      },
      "geo": { "lat": 52.530644, "lon": 13.383068 },
      "sourceUrl": "https://partner.example/expose/berlin-mitte-0042",
      "media": [
        { "url": "https://media.partner.example/berlin-mitte-0042/living-room.jpg" },
        { "url": "https://media.partner.example/berlin-mitte-0042/balcony.jpg" }
      ],
      "tours": [
        { "url": "https://my.matterport.com/show/?m=Zh14WDtkjdC", "providerCode": "matterport" }
      ],
      "source": "example-partner",
      "lastImportedAt": "2026-11-05T03:00:12.000Z",
      "lastRunId": "run-20261105-0300"
    }
  ]
}
```

## `GET /listings/{id}`

Returns the full record of one listing, in the same representation as the search results.

| Parameter         | In     | Type       | Allowed values                     | Description                                  |
| ----------------- | ------ | ---------- | ---------------------------------- | -------------------------------------------- |
| `id`              | path   | string     | 1 – 128 characters, percent-encode | Listing id. Required.                        |
| `lang`            | query  | BCP 47 tag | 1 – 35 characters                  | Preferred language; overrides the header.    |
| `Accept-Language` | header | string     | RFC 9110                           | Language preference, used if `lang` is unset |

An empty or too long `id` is `400 INVALID_ID`. An id that doesn't exist is `404 NOT_FOUND` with the
id in `details.id`. Fields:

| Field                                         | Type                 | Description                                                                |
| --------------------------------------------- | -------------------- | -------------------------------------------------------------------------- |
| `id`                                          | string               | Stable listing id; also the sort key.                                      |
| `title`, `description`                        | string               | Text of the delivered language version (`description` may be empty).       |
| `deliveredLocale`, `originalLocale`           | BCP 47 tag           | See [Languages](#languages).                                               |
| `offers`                                      | array (1–2)          | `SALE` and/or `RENT` offers, see [Offers](#offers).                        |
| `listingType`                                 | taxonomy type code   | Listing type.                                                              |
| `group`                                       | taxonomy group code  | Group of `listingType`; omitted if the type is no longer in the taxonomy.  |
| `rooms`                                       | number               | 0–99.5, step 0.5.                                                          |
| `area`                                        | decimal string       | Living or plot area in m².                                                 |
| `address`                                     | object               | `city`, `postalCode`, `country` (ISO 3166-1 alpha-2), optional `street`.   |
| `geo`                                         | object, optional     | `lat`, `lon` in degrees, rounded to 6 decimal places.                      |
| `sourceUrl`                                   | URL                  | Listing page at the source.                                                |
| `media`                                       | array (0–50)         | Media URLs (`https`) in display order.                                     |
| `tours`                                       | array (0–10)         | 3D tours: `url` (`https`) and `providerCode` from the tour allow-list.     |
| `contact`                                     | object, optional     | `name`, `phone`, `email`; only if the operator allows them for the source. |
| `source`, `lastImportedAt`, `lastRunId`       | string               | Provenance: connector, time of the last import (ISO 8601), import run.     |

### Example: listing with sale and rent offer

The listing's original language is German. The client prefers British English, then any English,
then German. There is no `en-GB` version, so the API picks `en`:

```sh request:detail
curl -sS -H "Accept-Language: en-GB,en;q=0.9,de;q=0.5" \
  "${API_URL}listings/berlin-mitte-0042"
```

```http head:detail
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
Vary: Origin
```

```json response:detail
{
  "id": "berlin-mitte-0042",
  "title": "Bright 3.5-room period apartment with balcony in Mitte",
  "description": "Renovated period apartment on the 3rd floor with stucco, wooden floors and a south-facing balcony. Available to buy or to rent.",
  "deliveredLocale": "en",
  "originalLocale": "de",
  "offers": [
    { "offerType": "SALE", "price": "450000.00", "currency": "EUR" },
    {
      "offerType": "RENT",
      "coldRent": "1250.50",
      "currency": "EUR",
      "additionalCosts": "280.00",
      "warmRent": "1530.50"
    }
  ],
  "listingType": "apartment_unit",
  "group": "apartment",
  "rooms": 3.5,
  "area": "92.40",
  "address": {
    "city": "Berlin",
    "postalCode": "10115",
    "country": "DE",
    "street": "Invalidenstraße 12"
  },
  "geo": { "lat": 52.530644, "lon": 13.383068 },
  "sourceUrl": "https://partner.example/expose/berlin-mitte-0042",
  "media": [
    { "url": "https://media.partner.example/berlin-mitte-0042/living-room.jpg" },
    { "url": "https://media.partner.example/berlin-mitte-0042/balcony.jpg" }
  ],
  "tours": [
    { "url": "https://my.matterport.com/show/?m=Zh14WDtkjdC", "providerCode": "matterport" }
  ],
  "source": "example-partner",
  "lastImportedAt": "2026-11-05T03:00:12.000Z",
  "lastRunId": "run-20261105-0300"
}
```

## `GET /openapi.json`

Returns the OpenAPI 3.1 document of the API. It is generated from the same schemas that validate
requests, and it contains every endpoint, every parameter with its type, required flag and bounds,
the listing model, the error format and the configured enumerations (taxonomy codes, offer types,
enabled locales). Use it to generate clients or as tool context for an agent. Clients may cache it
for five minutes (`Cache-Control: private, max-age=300`). Configuration changes appear after the
next Lambda reload.

```sh request:openapi
curl -sS "${API_URL}openapi.json"
```

```http head:openapi
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
Cache-Control: private, max-age=300
Vary: Origin
```

The document is long. This excerpt shows the header, the security scheme and the `/listings/{id}`
operation. Fetch the full document from your deployment.

```json response:openapi excerpt
{
  "openapi": "3.1.0",
  "info": {
    "title": "open-estate Search API",
    "version": "0.0.0",
    "description": "Real estate search for humans and AI agents. Error codes: see ErrorCode. With API-key access enabled, send `Authorization: Bearer <key>`."
  },
  "security": [{}, { "apiKey": [] }],
  "paths": {
    "/listings/{id}": {
      "get": {
        "operationId": "getListing",
        "summary": "Get one listing",
        "parameters": [
          {
            "in": "path",
            "name": "id",
            "schema": { "type": "string", "minLength": 1, "maxLength": 128 },
            "required": true,
            "description": "Listing id."
          },
          {
            "in": "query",
            "name": "lang",
            "schema": { "type": "string", "minLength": 1, "maxLength": 35 },
            "description": "Preferred language (BCP 47), overrides Accept-Language. Enabled locales: en, de; other tags fall back to the best available language version.",
            "x-enabled-locales": ["en", "de"]
          },
          {
            "in": "header",
            "name": "Accept-Language",
            "required": false,
            "description": "Language preference (RFC 9110); the `lang` parameter overrides it.",
            "schema": { "type": "string" }
          }
        ],
        "responses": {
          "200": {
            "description": "The listing.",
            "content": {
              "application/json": { "schema": { "$ref": "#/components/schemas/LocalizedListing" } }
            }
          },
          "400": { "$ref": "#/components/responses/BadRequest" },
          "401": { "$ref": "#/components/responses/Unauthorized" },
          "404": { "$ref": "#/components/responses/NotFound" },
          "429": { "$ref": "#/components/responses/RateLimited" },
          "503": { "$ref": "#/components/responses/ServiceUnavailable" }
        }
      }
    }
  },
  "components": {
    "securitySchemes": {
      "apiKey": {
        "type": "http",
        "scheme": "bearer",
        "description": "Required only when API-key access is enabled."
      }
    }
  }
}
```

## `GET /meta`

Returns what a client needs to build a search form: the property taxonomy (every group with its
type codes, in configuration order), the offer types, the enabled locales with labels and the
default locale, the default currency for price filters, the host names of the allowed tour providers
and all field bounds. Amount and area bounds are decimal strings. The cache rules are the same as
for `/openapi.json`.

```sh request:meta
curl -sS "${API_URL}meta"
```

```http head:meta
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
Cache-Control: private, max-age=300
Vary: Origin
```

```json response:meta
{
  "taxonomy": {
    "groups": [
      { "code": "apartment", "types": ["apartment_unit", "condominium", "penthouse", "loft"] },
      { "code": "house", "types": ["single_family", "villa", "terraced", "semi_detached"] },
      { "code": "land", "types": ["building_plot"] },
      { "code": "commercial", "types": ["office", "retail"] }
    ]
  },
  "offerTypes": ["SALE", "RENT"],
  "locales": {
    "defaultLocale": "en",
    "enabled": [
      { "locale": "en", "label": "English" },
      { "locale": "de", "label": "Deutsch" }
    ]
  },
  "defaultCurrency": "EUR",
  "tourProviders": ["my.matterport.com"],
  "bounds": {
    "listing": {
      "id": { "min": 1, "max": 128 },
      "title": { "min": 1, "max": 300 },
      "description": { "min": 0, "max": 5000 },
      "locale": { "min": 1, "max": 35 },
      "translations": { "max": 20 },
      "offers": { "min": 1, "max": 2 },
      "rooms": { "min": 0, "max": 99.5, "step": 0.5 },
      "listingType": { "min": 1, "max": 64 },
      "city": { "min": 1, "max": 200 },
      "postalCode": { "min": 1, "max": 10 },
      "street": { "min": 1, "max": 200 },
      "lat": { "min": -90, "max": 90 },
      "lon": { "min": -180, "max": 180 },
      "url": { "min": 1, "max": 2048 },
      "media": { "max": 50 },
      "tours": { "max": 10 },
      "providerCode": { "min": 1, "max": 64 },
      "contactName": { "min": 1, "max": 200 },
      "contactPhone": { "min": 1, "max": 50 },
      "contactEmail": { "min": 1, "max": 254 },
      "source": { "min": 1, "max": 128 },
      "runId": { "min": 1, "max": 128 },
      "money": { "min": "0.01", "max": "999999999.99" },
      "area": { "min": "1.00", "max": "100000.00" }
    },
    "search": {
      "pageSize": { "min": 1, "max": 50, "default": 20 },
      "types": { "min": 1, "max": 50 },
      "group": { "min": 1, "max": 1 },
      "pageToken": { "min": 1, "max": 1024 }
    }
  }
}
```

## Errors

Every error response has the same JSON body: a non-empty `errors` array. Each entry has a
machine-readable `code`, a human-readable `message`, the affected request `field` where there is
one, and sometimes `details`. A request with several invalid parameters gets one entry per problem.
The HTTP status is 400 if any entry is a validation error. Rate-limit errors also carry
`retryAfterSeconds`. Error responses are sent with `Cache-Control: no-store`.

| Code                        | HTTP | Cause                                                                                   |
| --------------------------- | ---- | --------------------------------------------------------------------------------------- |
| `INVALID_PARAMETER`         | 400  | Wrong syntax, type or range of a parameter (`field` names it).                          |
| `INVALID_RANGE`             | 400  | A minimum is greater than its maximum (`details.fields`).                               |
| `INVALID_PAGE_SIZE`         | 400  | `pageSize` is not an integer from 1 to 50.                                              |
| `INVALID_PAGE_TOKEN`        | 400  | `pageToken` is malformed or was issued for another query.                               |
| `INVALID_OFFER_TYPE`        | 400  | `offerType` is not `SALE` or `RENT`.                                                    |
| `OFFER_TYPE_REQUIRED`       | 400  | `priceMin`/`priceMax` without `offerType`.                                              |
| `CONFLICTING_FILTERS`       | 400  | `group` and `types` in one request.                                                     |
| `UNKNOWN_TAXONOMY_CODE`     | 400  | A `group` or `types` code isn't in the taxonomy; one error per code (`details.code`).    |
| `INVALID_FILTER_COUNT`      | 400  | More than one `group`, or zero or more than 50 `types` (`details.allowed`).              |
| `INVALID_LOCALE`            | 400  | `lang` is empty, longer than 35 characters or not a BCP 47 tag.                         |
| `INVALID_ID`                | 400  | The listing id is empty, too long or not validly percent-encoded.                       |
| `NOT_FOUND`                 | 404  | No listing with this id (`details.id`), or no such route.                               |
| `API_KEY_MISSING`           | 401  | API-key mode and no `Authorization` header.                                             |
| `API_KEY_INVALID`           | 401  | API-key mode and the key is unknown, revoked or expired, or not sent as `Bearer <key>`. |
| `FORBIDDEN`                 | 403  | Blocked by the gateway or WAF (or the admin API without permission).                    |
| `RATE_LIMITED`              | 429  | Rate limit reached; see `Retry-After` and `retryAfterSeconds`.                          |
| `SERVICE_UNAVAILABLE`       | 503  | Storage or search unreachable, deadline exceeded, or invalid configuration. Retry.      |
| `UNKNOWN_TOOL`              | —    | MCP only: unknown tool name, sent as a JSON-RPC error ([mcp.md](mcp.md#errors)).        |
| `DELETION_TARGET_NOT_FOUND` | 404  | Admin API only: a deletion request matched no listing.                                  |
| `INVALID_RATE_LIMIT`        | 400  | Admin API only: rate-limit value out of range.                                          |
| `AUTH_MISSING`              | 401  | Management API only: no `Authorization` header.                                         |
| `AUTH_INVALID`              | 401  | Management API only: token invalid/expired, unknown/revoked machine access, no access.  |
| `MACHINE_ACCESS_EXPIRED`    | 401  | Management API only: the machine access has expired.                                    |
| `AGENCY_SUSPENDED`          | 403  | Management API only: the caller's agency is suspended.                                  |
| `METRIC_NOT_ALLOWED`        | 403  | Management API only: metric outside the caller's scope (`details.code`).                |
| `VERSION_CONFLICT`          | 409  | Management API only: `baseVersion` is outdated (`details.currentVersion`).              |
| `CUSTOM_ID_TAKEN`           | 409  | Management API only: the custom id belongs to another listing of the agency.            |
| `DELETION_BLOCKED`          | 409  | Management API only: the id or custom id is on the deletion blocklist.                  |
| `LAST_AGENCY_ADMIN`         | 409  | Management API only: the agency would be left without an agency admin.                  |
| `LAST_PLATFORM_ADMIN`       | 409  | Management API only: the platform would be left without a platform admin.               |
| `USER_ALREADY_ASSIGNED`     | 409  | Management API only: the user already belongs to an agency or is a platform admin.      |
| `INVALID_PERMISSION`        | 400  | Management API only: unknown or non-grantable permission (`details.permission`).        |
| `UNKNOWN_METRIC`            | 400  | Management API only: unknown metric code (`details.code`).                              |

The `ErrorCode` schema in `/openapi.json` lists the same codes. A 503 never reveals internal details.

### 400: invalid parameters

All problems are reported at once:

```sh request:error-400
curl -sS "${API_URL}listings?priceMin=500000&priceMax=100000&group=apartment&types=loft&pageSize=100"
```

```http head:error-400
HTTP/1.1 400 Bad Request
Content-Type: application/json; charset=utf-8
Cache-Control: no-store
Vary: Origin
```

```json response:error-400
{
  "errors": [
    {
      "code": "INVALID_PAGE_SIZE",
      "message": "Too big: expected number to be <=50",
      "field": "pageSize"
    },
    {
      "code": "OFFER_TYPE_REQUIRED",
      "message": "A price filter requires offerType (SALE or RENT)",
      "field": "offerType"
    },
    {
      "code": "CONFLICTING_FILTERS",
      "message": "group and types cannot be combined; use either group or types",
      "field": "group,types",
      "details": { "fields": ["group", "types"] }
    },
    {
      "code": "INVALID_RANGE",
      "message": "priceMin must be less than or equal to priceMax",
      "field": "priceMin",
      "details": { "fields": ["priceMin", "priceMax"] }
    }
  ]
}
```

### 404: listing not found

```sh request:error-404
curl -sS "${API_URL}listings/does-not-exist"
```

```http head:error-404
HTTP/1.1 404 Not Found
Content-Type: application/json; charset=utf-8
Cache-Control: no-store
Vary: Origin
```

```json response:error-404
{
  "errors": [
    {
      "code": "NOT_FOUND",
      "message": "Listing does-not-exist not found",
      "details": { "id": "does-not-exist" }
    }
  ]
}
```

### 401: API key missing

In API-key mode, without an `Authorization` header:

```sh request:error-401 access=api-keys
curl -sS "${API_URL}listings?city=Berlin"
```

```http head:error-401
HTTP/1.1 401 Unauthorized
Content-Type: application/json; charset=utf-8
Cache-Control: no-store
Vary: Origin
```

```json response:error-401
{ "errors": [{ "code": "API_KEY_MISSING", "message": "API key is required" }] }
```

### 429: rate limited

The 61st request within one 60-second window, 15 seconds into the window:

```sh request:error-429 repeat=61
curl -sS "${API_URL}listings?city=Berlin"
```

```http head:error-429
HTTP/1.1 429 Too Many Requests
Content-Type: application/json; charset=utf-8
Cache-Control: no-store
Retry-After: 45
Vary: Origin
```

```json response:error-429
{
  "errors": [
    {
      "code": "RATE_LIMITED",
      "message": "Rate limit of 60 requests per 60 s exceeded",
      "details": { "retryAfterSeconds": 45 }
    }
  ],
  "retryAfterSeconds": 45
}
```
