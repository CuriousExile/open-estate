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
