# Management API

The Management API is the write side of open-estate. Agencies manage their listings through it:
create, edit, activate and deactivate listings, browse the version history and restore earlier
versions. The agency portal uses only this API, and integrations of an agency use it with a
machine access. Platform admins use it for agencies, members and platform operations.

The machine-readable description of every operation, with its required permission
(`x-required-permission`), parameters, bodies, responses and error codes, is the OpenAPI 3.1
document at `GET /openapi.json` (no authentication). This page covers what the OpenAPI document
does not: who may do what, a complete machine-access example and how imports from connectors
interact with manual changes.

## Contents

- [Base URL](#base-url)
- [Authentication](#authentication)
- [Permissions](#permissions)
- [Example: a machine access end to end](#example-a-machine-access-end-to-end)
- [Duplicate detection](#duplicate-detection)
- [Repeating a creation safely](#repeating-a-creation-safely)
- [Import modes](#import-modes)

## Base URL

The base URL is the `ManagementApiUrl` output of the `OpenEstate-<env>-Management` stack. It ends
with the stage and a slash:

```sh
export MGMT_URL=$(aws cloudformation describe-stacks --stack-name OpenEstate-dev-Management \
  --query "Stacks[0].Outputs[?OutputKey=='ManagementApiUrl'].OutputValue" --output text)
curl -sS "${MGMT_URL}openapi.json" | jq '.info.title'
```

Errors use the same format and error catalog as the [Search API](api.md): a body
`{"errors": [{"code", "message", "field"?, "details"?}]}`, with `retryAfterSeconds` and a
`Retry-After` header on `429 RATE_LIMITED`.

## Authentication

Every operation except `GET /openapi.json` needs an `Authorization: Bearer …` header with one of:

- the Cognito **access token** of a portal user (agency member, agency admin or platform admin), or
- the **credential of a machine access**: `oem_<keyId>_<secret>`.

| Status | Code                     | Cause                                                        |
| ------ | ------------------------ | ------------------------------------------------------------ |
| 401    | `AUTH_MISSING`           | No `Authorization` header                                    |
| 401    | `AUTH_INVALID`           | Unknown, malformed or revoked token or credential            |
| 401    | `MACHINE_ACCESS_EXPIRED` | The machine access is past its `expiresAt`                   |
| 403    | `AGENCY_SUSPENDED`       | The agency of the caller is suspended                        |
| 403    | `FORBIDDEN`              | The caller lacks the permission of the operation             |
| 404    | `NOT_FOUND`              | The resource does not exist or belongs to another agency     |
| 429    | `RATE_LIMITED`           | Too many requests; wait `retryAfterSeconds` before you retry |

A resource of another agency is always reported as `404 NOT_FOUND`, never `403`, so a caller cannot
probe for foreign listings.

### Machine accesses

A machine access belongs to exactly one agency and acts only within it. An agency admin creates it
in the portal or with `POST /agencies/{agencyId}/machine-access`, choosing a label, the
permissions and an optional expiry. Only the permissions in the column "Machine access
(grantable)" of the [matrix](#permissions) can be granted; any other permission is rejected with
one `400 INVALID_PERMISSION` per entry. The response contains the credential in `secret`. It is
shown **exactly once**: the platform stores only a hash. Store it in your secret manager.

A revoked access is rejected within 60 seconds. Changes made with a machine access are recorded
with channel `API` and the access as the actor (`{"kind": "machine", "keyId", "label"}`).

## Permissions

Each role and each machine access maps to a fixed set of permissions. Agency roles and machine
accesses act only within their own agency; `PLATFORM_ADMIN` holds every permission for every
agency and platform-wide (for example, `audit:read` without an agency filter).

The table is generated from `packages/shared/src/permissions.ts`, which the backend and the portal
use too. Do not edit it by hand: run `npm run docs:permissions` after changing permissions
(`node scripts/generate-permission-matrix.mjs --check` reports drift).

<!-- BEGIN GENERATED: permission-matrix -->

| Permission              | Allows                                                                                         | `AGENCY_MEMBER` | `AGENCY_ADMIN` | `PLATFORM_ADMIN` | Machine access (grantable) |
| ----------------------- | ---------------------------------------------------------------------------------------------- | :-------------: | :------------: | :--------------: | :------------------------: |
| `listing:read`          | Read listings, their version history and diffs                                                 |        ✓        |       ✓        |        ✓         |             ✓              |
| `listing:write`         | Create listings and replace their content and Custom_Id                                        |        ✓        |       ✓        |        ✓         |             ✓              |
| `listing:status`        | Activate and deactivate listings                                                               |        ✓        |       ✓        |        ✓         |             ✓              |
| `version:restore`       | Restore the content of an earlier version                                                      |        ✓        |       ✓        |        ✓         |             ✓              |
| `monitoring:read`       | Agency monitoring: overview, connector runs, usage, metrics                                    |        ✓        |       ✓        |        ✓         |             ✓              |
| `audit:read`            | Query the audit log                                                                            |        –        |       ✓        |        ✓         |             ✓              |
| `member:manage`         | Add and remove members, change their roles                                                     |        –        |       ✓        |        ✓         |             –              |
| `machine-access:manage` | Create, list and revoke machine accesses                                                       |        –        |       ✓        |        ✓         |             –              |
| `agency:manage`         | Create, rename, suspend and reactivate agencies; manage platform admins                        |        –        |       –        |        ✓         |             –              |
| `platform:operate`      | Admin API functions under `/platform/*`: deletions, API keys, rate limits, access mode, reload |        –        |       –        |        ✓         |             –              |
| `monitoring:platform`   | Platform metrics, alarms, agency activity, history size                                        |        –        |       –        |        ✓         |             –              |
| `listing:assign`        | Assign a listing to another agency                                                             |        –        |       –        |        ✓         |             –              |
| `duplicate:review`      | Review and dismiss duplicates found across agencies                                            |        –        |       –        |        ✓         |             –              |

<!-- END GENERATED: permission-matrix -->

Which operation needs which permission is listed per operation in `/openapi.json`
(`x-required-permission`). `GET /me` returns the effective permissions of the caller.

## Example: a machine access end to end

This example creates a listing with a Custom_Id, fetches it by that Custom_Id, activates it,
changes its price, reads the version history and restores the first version. It assumes a machine
access with `listing:read`, `listing:write`, `listing:status` and `version:restore` and uses
[`jq`](https://jqlang.org/) to read values from responses.

### 1. Authenticate

Create the machine access once, as agency admin (portal user token in `$PORTAL_TOKEN`):

```sh
curl -sS -X POST "${MGMT_URL}agencies/${AGENCY_ID}/machine-access" \
  -H "Authorization: Bearer $PORTAL_TOKEN" -H 'Content-Type: application/json' \
  -d '{
    "label": "CRM sync",
    "permissions": ["listing:read", "listing:write", "listing:status", "version:restore"]
  }' | jq -r '.secret'
```

The printed value has the form `oem_<keyId>_<secret>`. Every following request sends it as bearer
token. `GET /me` confirms the identity and the granted permissions:

```sh
export OEM_CREDENTIAL='oem_<keyId>_<secret>'   # from your secret manager
curl -sS "${MGMT_URL}me" -H "Authorization: Bearer $OEM_CREDENTIAL"
```

```json
{
  "kind": "machine",
  "id": "<keyId>",
  "displayName": "CRM sync",
  "agencyId": "<agencyId>",
  "permissions": ["listing:read", "listing:write", "listing:status", "version:restore"]
}
```

### 2. Create a listing with a Custom_Id

`POST /listings` takes the listing content, an optional `status` (default `INACTIVE`) and an
optional `customId`: your own reference, 1–128 characters, unique within the agency. The content
uses the input format of the [Search API](api.md#amounts-and-areas): amounts and areas as decimal
strings. Without `sourceUrl` the platform uses the public detail URL of the listing.

```sh
curl -sS -X POST "${MGMT_URL}listings" \
  -H "Authorization: Bearer $OEM_CREDENTIAL" -H 'Content-Type: application/json' \
  -d '{
    "customId": "CRM-4711",
    "content": {
      "originalLocale": "de",
      "title": "Helle Altbauwohnung in Mitte",
      "description": "Drei Zimmer mit Balkon und Blick in den Hof.",
      "translations": [
        { "locale": "en", "title": "Bright period flat in Mitte", "description": "Three rooms with a balcony." }
      ],
      "offers": [{ "offerType": "SALE", "price": "350000.00", "currency": "EUR" }],
      "listingType": "apartment_unit",
      "rooms": 3,
      "area": "85.50",
      "address": { "city": "Berlin", "postalCode": "10115", "country": "DE" },
      "media": [],
      "tours": []
    }
  }'
```

The answer is `201` with the full listing (`ListingView`). Excerpt:

```json
{
  "id": "4f0c2a8e-7d1b-4c55-9a43-2b6f0e8d9c11",
  "status": "INACTIVE",
  "origin": "MANUAL",
  "customId": "CRM-4711",
  "version": 1,
  "sourceUrlDerived": true
}
```

If another listing of the agency already has the Custom_Id, the answer is `409 CUSTOM_ID_TAKEN`.
Contact fields not allowed by the platform's PII allowlist and invalid media or tours are dropped
and named in `droppedFields`.

### 3. Fetch the listing by its Custom_Id

```sh
curl -sS "${MGMT_URL}listings/by-custom-id/CRM-4711" \
  -H "Authorization: Bearer $OEM_CREDENTIAL" | tee listing.json | jq '{id, version, status}'
export LISTING_ID=$(jq -r '.id' listing.json)
```

URL-encode Custom_Ids with reserved characters (`/`, `?`, `#`, spaces). An unknown Custom_Id
answers `404 NOT_FOUND`.

To check several listings at once — for example a page of Search API results — look them up by
id: `GET /listings?ids=<id>,<id>,…` (1 to 50 ids) answers with the `ListingSummary` (status,
version, Custom_Id, …) of every listing among them that you may read, in the given order, in one
page. Unknown ids and listings of other agencies are left out, as if they did not exist; `ids`
cannot be combined with the other filters or `pageToken`.

```sh
curl -sS -G "${MGMT_URL}listings" --data-urlencode "ids=${LISTING_ID},some-other-id" \
  -H "Authorization: Bearer $OEM_CREDENTIAL" | jq '.items[] | {id, status, version}'
```

### 4. Change the listing status

`PUT /listings/{id}/status` sets `ACTIVE` or `INACTIVE`. `baseVersion` is optional here; if given,
it must equal the current version.

```sh
curl -sS -X PUT "${MGMT_URL}listings/${LISTING_ID}/status" \
  -H "Authorization: Bearer $OEM_CREDENTIAL" -H 'Content-Type: application/json' \
  -d '{ "status": "ACTIVE", "baseVersion": 1 }' | jq '{status, version}'
```

```json
{ "status": "ACTIVE", "version": 2 }
```

Within 60 seconds the listing is visible in the Search API and the MCP server.

### 5. Change the content

`PUT /listings/{id}` replaces the whole content. `baseVersion` is required and must equal the
current version (optimistic locking); otherwise the answer is `409 VERSION_CONFLICT`, and you
should fetch the listing again and reapply your change. Here the price drops:

```sh
jq '.sourceUrlDerived as $derived | {
  content: (.content | if $derived then del(.sourceUrl) else . end | .offers[0].price = "339000.00"),
  baseVersion: 2
}' listing.json |
  curl -sS -X PUT "${MGMT_URL}listings/${LISTING_ID}" \
    -H "Authorization: Bearer $OEM_CREDENTIAL" -H 'Content-Type: application/json' \
    -d @- | jq '{version}'
```

```json
{ "version": 3 }
```

The content of a `ListingView` is the input format, so you can send it back changed. Drop
`sourceUrl` if `sourceUrlDerived` is `true`; otherwise the public detail URL would be stored as
your own source URL. `customId` in this body is optional: leave it out to keep the Custom_Id, send
a value to change it or `null` to remove it.

### 6. Read the version history

`GET /listings/{id}/versions` lists the versions newest first, paged with `pageSize` and
`pageToken`. `GET /listings/{id}/versions/{n}` returns one version with its full content, and
`GET /listings/{id}/diff?from=1&to=3` the field-level difference of two versions.

```sh
curl -sS "${MGMT_URL}listings/${LISTING_ID}/versions" \
  -H "Authorization: Bearer $OEM_CREDENTIAL" |
  jq '.items[] | {version, changeType, channel, status, changedPaths: [.changedPaths[].path]}'
```

After the steps above the history is:

| `version` | `changeType` | `channel` | `status`   | `changedPaths`     |
| --------- | ------------ | --------- | ---------- | ------------------ |
| 3         | `UPDATE`     | `API`     | `ACTIVE`   | `offers`           |
| 2         | `STATUS`     | `API`     | `ACTIVE`   | –                  |
| 1         | `CREATE`     | `API`     | `INACTIVE` | every content path |

Paths are content paths: nested objects are split into their fields (`address.city`), lists such
as `offers` count as one path. Each entry also names the `actor` and `createdAt`.

### 7. Restore a version

`POST /listings/{id}/restore` copies the content of `version` into a new version. Status and
Custom_Id stay as they are. `baseVersion` must equal the current version.

```sh
curl -sS -X POST "${MGMT_URL}listings/${LISTING_ID}/restore" \
  -H "Authorization: Bearer $OEM_CREDENTIAL" -H 'Content-Type: application/json' \
  -d '{ "version": 1, "baseVersion": 3 }' | jq '{version, status, price: .content.offers[0].price}'
```

```json
{ "version": 4, "status": "ACTIVE", "price": "350000.00" }
```

The new version has `changeType` `RESTORE` and `restoredFrom` `1`. Restoring a version whose
content equals the current content creates no new version.

## Duplicate detection

The platform recognises when a listing describes a property the same agency already offers — a
listing posted twice, typed a little differently, or reposted with a new text. Only the first one
stays online; every later one is stored, but **inactive** and with a `DUPLICATE` flag, so the agency
can decide. The check runs on every channel (portal, machine access, admin mode, connectors), so
this section applies to imports as well.

Platform admins can switch the whole duplicate detection off (for example to save its cost) and on
again; while it is off, listings are stored without check and without flag (see
[Switching it off](#switching-it-off)).

### When listings are checked

| Event                                                           | Result                                                                                                                           |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `POST /listings`, connector creates a listing                   | Duplicate of an older listing: stored `INACTIVE` with a flag (`detectedBy: CREATE`), whatever status was requested; answer `201` |
| `PUT /listings/{id}`, restore, agency assignment, import update | The flag is set, updated or removed (`detectedBy: UPDATE`); the status never changes                                             |
| Daily duplicate check (all listings, 03:00 UTC by default)      | Flags of all listings renewed (`detectedBy: SWEEP`), e.g. after rule changes; the status never changes                           |
| Status or Custom_Id only                                        | The flag stays as it is (except for the release below)                                                                           |

A listing is only compared with listings of **its own agency** (listings without agency form one
group of their own). Flags never name listings of other agencies; duplicates across agencies are
reported to platform admins only (see [below](#duplicates-across-agencies)). The older of two
duplicates is the **original** (earlier creation time); a flag names the original and up to five
matches.

A stored duplicate version 1 carries `statusReason: {"code": "DUPLICATE", "originalId": …}` in
the version history, so it is clear why the listing is inactive. `GET /listings?flag=DUPLICATE`
lists the flagged listings of the agency; every `ListingSummary` has `flagCodes`.

### Rules

Two listings are compared in this order (defaults of `duplicate-detection.json`, see
[configuration](configuration.md#duplicate-detection)):

1. **Different properties.** Never duplicates if the country, the property group of the listing
   type or every offer type differs, or if both have a value that differs for street and house
   number, unit (`address.unit`), floor or parcel (`parcelId`).
2. **Exact duplicate.** Equal in every compared part (normalised address, area, rooms, offers,
   attributes, texts, media): a duplicate with value 1 and reason `EXACT`.
3. **Location anchor.** Otherwise only pairs with a common anchor are compared further: same
   street and house number, coordinates within 50 m, same parcel, same source URL, or same postal
   code with nearly equal title and description. Two flats of the same size in the same city are
   not enough.
4. **Value.** The weights of all reasons that apply are added up (between 0 and 1). A pair is a
   duplicate from a value of **0.7**.

Before comparing, the platform normalises spelling: case, umlauts and accents (`Müller` =
`Mueller`, `ß` = `ss`), punctuation and spacing, street suffixes (`Str.` = `Straße`), house numbers
inside the street line, unit words (`Whg`, `WE`, `Apt`), postal code spacing and the decimals of
areas and amounts. URLs are compared as given. A derived source URL (the public detail page) is not
compared.

| Reason              | Weight | Applies when                                                 |
| ------------------- | -----: | ------------------------------------------------------------ |
| `EXACT`             |      – | Exact duplicate (value 1)                                    |
| `SAME_SOURCE_URL`   |   0.60 | Same source URL                                              |
| `SAME_PARCEL`       |   0.45 | Same parcel reference                                        |
| `SAME_ADDRESS`      |   0.35 | Same street and house number                                 |
| `GEO_NEAR`          |   0.30 | Coordinates within 15 m                                      |
| `GEO_ANCHOR`        |   0.15 | Coordinates within 50 m, but more than 15 m apart            |
| `SAME_UNIT`         |   0.10 | Same unit                                                    |
| `AREA_CLOSE`        |   0.20 | Living area within 2 %                                       |
| `AREA_NEAR`         |   0.10 | Living area within 5 %                                       |
| `AREA_DIFFERS`      |  −0.40 | Living areas differ by more than 10 %                        |
| `ROOMS_EQUAL`       |   0.10 | Same number of rooms                                         |
| `ROOMS_DIFFER`      |  −0.30 | Rooms differ by one or more                                  |
| `ATTRIBUTES_EQUAL`  |   0.03 | Per property attribute both have with the same value         |
| `ATTRIBUTES_DIFFER` |  −0.25 | A property attribute both have differs                       |
| `PRICE_CLOSE`       |   0.05 | Same offer type and currency, price within 5 %               |
| `TITLE_NEAR`        |   0.10 | Titles nearly equal                                          |
| `DESCRIPTION_NEAR`  |   0.15 | Descriptions nearly equal                                    |
| `MEDIA_SHARED`      |   0.15 | One media URL in common                                      |
| `MEDIA_SHARED_2`    |   0.30 | Two or more media URLs in common (instead of `MEDIA_SHARED`) |

The [property attributes](api.md#property-attributes) (`address.unit`, `floor`, `yearBuilt`,
`plotArea`, `parcelId`, …) make the check more precise: identical flats of one building are told
apart by their unit or floor. Without them, two flats of the same size, price and rooms at the
same address are reported as possible duplicates — release the one that is not a copy.

### Release and dismiss

| Operation                                 | Effect                                                                                                                                                                                        |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUT /listings/{id}/status` with `ACTIVE` | Activates a flagged listing, removes the flag and records that it is no duplicate of any of its current matches (new version). For a listing that is already active it is the dismissal below |
| `DELETE /listings/{id}/flags/DUPLICATE`   | Removes the flag and records the same for every current match; status and version stay. Without a flag: `200` without change                                                                  |

Both need `listing:status`. A released or dismissed pair is never flagged again for each other,
neither on later changes nor by the daily check. Flag changes are written to the audit log
(`listing.flag.set`, `listing.flag.update`, `listing.flag.remove`, `listing.flag.dismiss`) with
codes and ids only.

#### Example: create a duplicate and release it

Create the listing of [step 2](#2-create-a-listing-with-a-custom_id) a second time, this time
without a Custom_Id, typed a little differently and with `"status": "ACTIVE"`:

```sh
curl -sS -X POST "${MGMT_URL}listings" \
  -H "Authorization: Bearer $OEM_CREDENTIAL" -H 'Content-Type: application/json' \
  -d '{
    "status": "ACTIVE",
    "content": {
      "originalLocale": "de",
      "title": "Helle Altbauwohnung in Mitte",
      "description": "Drei Zimmer mit Balkon und Blick in den Hof.",
      "translations": [],
      "offers": [{ "offerType": "SALE", "price": "350000", "currency": "EUR" }],
      "listingType": "apartment_unit",
      "rooms": 3,
      "area": "85.5",
      "address": { "city": "Berlin", "postalCode": "10 115", "country": "DE" },
      "media": [],
      "tours": []
    }
  }' | tee duplicate.json | jq '{id, status, flags}'
```

The answer is `201`, but the listing is stored inactive:

```json
{
  "id": "9b7e1d20-5c3a-4f8e-b1a2-6d4c8e0f2a77",
  "status": "INACTIVE",
  "flags": [
    {
      "code": "DUPLICATE",
      "updatedAt": "2026-03-01T10:15:00.000Z",
      "detectedBy": "CREATE",
      "originalId": "4f0c2a8e-7d1b-4c55-9a43-2b6f0e8d9c11",
      "matches": [
        { "listingId": "4f0c2a8e-7d1b-4c55-9a43-2b6f0e8d9c11", "score": 1, "reasons": ["EXACT"] }
      ]
    }
  ]
}
```

After normalising (`350000` = `350000.00`, `85.5` = `85.50`, `10 115` = `10115`) both listings are
equal in every compared part: an exact duplicate. Translations, the Custom_Id and the derived
source URL are not compared. If the second listing is meant to be online — for example a second
flat of the same size in the same building — release it:

```sh
export DUPLICATE_ID=$(jq -r '.id' duplicate.json)
curl -sS -X PUT "${MGMT_URL}listings/${DUPLICATE_ID}/status" \
  -H "Authorization: Bearer $OEM_CREDENTIAL" -H 'Content-Type: application/json' \
  -d '{ "status": "ACTIVE" }' | jq '{status, version, flags}'
```

```json
{ "status": "ACTIVE", "version": 2, "flags": [] }
```

To keep it offline but stop the notice, dismiss the flag instead:
`curl -sS -X DELETE "${MGMT_URL}listings/${DUPLICATE_ID}/flags/DUPLICATE" -H "Authorization: Bearer $OEM_CREDENTIAL"`.

### Duplicates across agencies

The daily check also compares listings of different agencies. It never changes their status or
flags; it records each pair as a report for platform admins (`duplicate:review`, not grantable to
machine accesses):

| Method | Path                                             | Permission         | Purpose                                                                                           |
| ------ | ------------------------------------------------ | ------------------ | ------------------------------------------------------------------------------------------------- |
| `GET`  | `/platform/duplicate-reports?state=&agencyId=`   | `duplicate:review` | Reports by descending value; `state` `OPEN` (default), `DISMISSED` or `RESOLVED`; paged           |
| `POST` | `/platform/duplicate-reports/{reportId}/dismiss` | `duplicate:review` | Dismiss a report; it is not reopened while both listings exist                                    |
| `POST` | `/platform/duplicate-sweeps`                     | `platform:operate` | Start the daily check now (`202`, `{executionName, alreadyRunning}`); a running check is returned |

A report that the next check no longer finds becomes `RESOLVED`; if the pair matches again later,
it is `OPEN` again. The metric `duplicate.cross_agency_open` counts the open reports,
`listing.duplicate_flags` the flagged listings per agency (see `GET /metrics`).

### Switching it off

| Method | Path                            | Permission         | Purpose                                                                         |
| ------ | ------------------------------- | ------------------ | ------------------------------------------------------------------------------- |
| `GET`  | `/platform/duplicate-detection` | `platform:operate` | `{"enabled": true}` or `{"enabled": false}`                                     |
| `PUT`  | `/platform/duplicate-detection` | `platform:operate` | Body `{"enabled": false}` or `{"enabled": true}`; answers the new state (below) |

The admin mode has the same switch under **Operations**; a deployment sets the initial value
(`-c duplicateDetection=disabled`, [configuration](configuration.md#switching-it-on-and-off)).
Running functions apply a change within 60 seconds.

While it is off, creations, changes and imports are stored as requested: no candidate search, no
flag (a duplicate stays `ACTIVE`), no duplicate index writes; the daily check ends right after its
start and `POST /platform/duplicate-sweeps` answers `409 DUPLICATE_DETECTION_DISABLED`. Existing
flags and reports stay; activating a flagged listing or `DELETE /listings/{id}/flags/DUPLICATE`
still releases it against the listings its flag names.

Switching it on starts a check at once, which rebuilds the index and renews every flag:

```sh
# Platform admin's portal token in $PORTAL_TOKEN (machine accesses cannot hold platform:operate).
curl -sS -X PUT "${MGMT_URL}platform/duplicate-detection" \
  -H "Authorization: Bearer $PORTAL_TOKEN" -H 'Content-Type: application/json' \
  -d '{"enabled": true}'
# {"enabled":true,"sweep":{"executionName":"manual-20260301T101500-000Z","alreadyRunning":false}}
```

`sweep` is missing if the check could not be started; the next daily run (or a manual start)
catches up. Listings created while the detection was off are flagged by that check but stay online.

## Repeating a creation safely

`POST /listings` accepts an optional header `Idempotency-Key` (1–128 printable ASCII characters
without spaces, for example the id of the listing in your CRM). Within 24 hours, a repetition with
the same key and the same body returns the listing created first (`201` with header
`Idempotent-Replayed: true`) instead of creating another one, so a request repeated after a timeout
is harmless. Keys belong to the caller (user or machine access); other callers may use the same
key.

```sh
curl -sS -i -X POST "${MGMT_URL}listings" \
  -H "Authorization: Bearer $OEM_CREDENTIAL" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: crm-4712' \
  -d @listing.json
```

| Case                                  | Answer                                                  |
| ------------------------------------- | ------------------------------------------------------- |
| First request                         | `201`, the new listing                                  |
| Same key, same body, within 24 h      | `201`, the same listing, `Idempotent-Replayed: true`    |
| Same key, another body, within 24 h   | `409 IDEMPOTENCY_KEY_REUSED`, nothing changed           |
| Invalid key (empty, too long, spaces) | `400 INVALID_PARAMETER` with `field: "Idempotency-Key"` |

Without the header, two identical requests create two listings — the second one as a flagged
duplicate (see above).

## Import modes

Listings of an agency can also come from a [connector](connectors.md) with `agencyId` in
`connectors.json`. When a connector delivers a record for an existing listing, the import mode
decides how it combines with the stored content, including manual changes:

| Mode      | Effect                                                                                                                                                                                                                   |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MERGE`   | Only delivered fields are overwritten. Objects are merged field by field, lists and scalar values are replaced, `null` removes a field at any level. Fields the record does not contain, such as manual additions, stay. |
| `REPLACE` | The delivered record replaces the whole content (`null` counts as missing). A field that disappeared at the source is removed on the next import, manual changes are overwritten.                                        |

The mode is resolved per connector in this order:

1. `importMode` of the connector in `connectors.json`,
2. otherwise the `defaultImportMode` of the connector module,
3. otherwise `MERGE`.

The built-in modules deliver a complete record per listing and therefore default to `REPLACE`:

| Module          | `defaultImportMode` |
| --------------- | ------------------- |
| `web-crawler`   | `REPLACE`           |
| `relational-db` | `REPLACE`           |
| `external-api`  | `REPLACE`           |

A custom module without `defaultImportMode` imports with `MERGE`. Set `"importMode": "MERGE"` on a
built-in connector if the agency edits imported listings and the source delivers only part of the
fields.

An import can overwrite a field last changed manually. The version history shows such fields with
`overwrittenByImport: true`, and the portal highlights them, so the change can be restored as
shown [above](#7-restore-a-version).
