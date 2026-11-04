# @open-estate/admin

Admin-API Lambda (`/admin/*`, IAM-authorized) and the `open-estate-admin` CLI.

## `open-estate-admin`

The CLI lives in this package (`src/cli/`, binary `dist/cli/bin.js`). It is not re-exported from the
package index, so the Lambda bundles never include it or its extra dependencies
(`@aws-sdk/client-lambda`, `@aws-sdk/credential-provider-node`, `@smithy/signature-v4`).

```bash
npm run build
npx open-estate-admin --help            # from the repo root (workspace bin)
```

Every command except `reload` sends a SigV4-signed request (service `execute-api`) to the Admin-API.
Credentials come from the AWS default credential chain (environment, `--profile`/`AWS_PROFILE`, SSO,
container, IMDS); the caller needs `execute-api:Invoke` on `/admin/*`.

| Option | Default |
| --- | --- |
| `--url <url>` | `$OPEN_ESTATE_ADMIN_URL`; base URL including the stage, e.g. `https://abc123.execute-api.eu-central-1.amazonaws.com/prod` (HTTPS only) |
| `--region <region>` | `$AWS_REGION`, then `$AWS_DEFAULT_REGION`, then the region in the execute-api host name |
| `--profile <name>` | `$AWS_PROFILE` / default profile |

| Command | Request |
| --- | --- |
| `create-key [--expires-at <ISO>] [--requests <n> --window-seconds <n>]` | `POST /admin/api-keys` |
| `revoke-key <keyId>` | `DELETE /admin/api-keys/{keyId}` |
| `set-key-rate-limit <keyId> --requests <n> --window-seconds <n>` | `PUT /admin/api-keys/{keyId}/rate-limit` |
| `set-rate-limit --requests <n> --window-seconds <n>` | `PUT /admin/rate-limit` |
| `set-access-mode <open\|api-keys>` | `PUT /admin/access-mode` |
| `request-deletion --listing-id <id> \| --source <source>` | `POST /admin/deletions` |
| `get-deletion <requestId>` | `GET /admin/deletions/{requestId}` |
| `unblock-listing <listingId>` | `DELETE /admin/deletion-blocklist/{listingId}` |
| `reload [--function <name>]...` | Lambda `UpdateFunctionConfiguration` (see below) |

Output: the response body as JSON on stdout. Errors go to stderr: the HTTP status and the `ApiError`
body (for example `INVALID_RATE_LIMIT` with the rejected value), or the network/credential error.
Exit codes: `0` success, `1` API, network or reload failure, `2` invalid command line. Value ranges
are validated by the Admin-API, not by the CLI. Credentials and signatures are never printed. The only
secret ever printed is the plaintext `apiKey` in the `create-key` response; it is shown once, and a
notice on stderr says so.

```bash
export OPEN_ESTATE_ADMIN_URL=https://abc123.execute-api.eu-central-1.amazonaws.com/prod
open-estate-admin set-rate-limit --requests 100 --window-seconds 60
open-estate-admin create-key --expires-at 2027-01-01T00:00:00Z > key.json
open-estate-admin request-deletion --source partner-a
open-estate-admin get-deletion 0f8c…
```

A value that starts with `-` has to be passed as `--requests=-1`.

### `reload`

Lambda functions load the taxonomy and the tour and crawler allowlists at init only. To apply such
changes without `cdk deploy` (Req 15.3, 16.8), `reload` sets the `CONFIG_VERSION` environment variable
of each function to the next integer (missing or non-integer values restart at `1`). Any
configuration change makes Lambda start new execution environments, so the next invocations are
cold starts. Rate limits and the access mode need no reload; they are applied within 60 s.

```bash
open-estate-admin reload --function OpenEstate-prod-Api-ListingsFunction --function …
OPEN_ESTATE_RELOAD_FUNCTIONS=fn-a,fn-b open-estate-admin reload
```

- All other environment variables are written back unchanged. The update carries the `RevisionId`
  that was read, so a concurrent change fails instead of being overwritten.
- If the environment cannot be read (for example, no `kms:Decrypt` on an encrypted environment), the
  function is skipped, because writing back would erase its variables.
- Functions are handled one at a time. A failure is reported and the remaining functions are still
  handled; the exit code is `1` if any function failed.
- The region comes from `--region`, `$AWS_REGION`, `$AWS_DEFAULT_REGION` or the profile.

Infrastructure needed (14.10):

- the function names (for example as stack outputs);
- `lambda:GetFunctionConfiguration` and `lambda:UpdateFunctionConfiguration` on those functions in the
  administrator IAM policy.

The next `cdk deploy` sets `CONFIG_VERSION` back to the value from the stack (if any). That is fine,
because a deploy restarts the functions as well.
