# Installation and troubleshooting

This guide deploys OpenEstate into an AWS account with the AWS CDK, loads the sample listings and
covers the failures you are most likely to hit. All commands run from the repository root unless a
step says otherwise.

To try the platform in the browser **without AWS**, run the in-memory local demo instead:
`npm run dev` — see [local-demo.md](local-demo.md).

- [Prerequisites](#prerequisites)
- [Deploy step by step](#deploy-step-by-step)
- [Optional: OpenSearch search provider](#optional-opensearch-search-provider)
- [Production deployment](#production-deployment)
- [Teardown](#teardown)
- [Configuration overrides](#configuration-overrides)
- [Troubleshooting](#troubleshooting)

## Prerequisites

| Requirement                  | Notes                                                                                                                                                                                                                                                       |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js `^22.22.3`, `^24.15.0` or `>=26` | Required by the Angular 22 build of `packages/frontend` (its `engines` field). The root `engines` (`>=20.19.0`) covers the backend only; `npm run build` fails on older versions. CI uses Node 22.x. Lambdas run on `nodejs22.x`. |
| npm `>=10`                   | Ships with Node. The repository is an npm workspace; use `npm ci` for a reproducible install.                                                                                                                                                               |
| AWS account and credentials  | Any credential source of the AWS CLI/SDK chain (`AWS_PROFILE`, SSO, environment). The deploying principal needs CloudFormation and the rights to create the resources (in practice `AdministratorAccess` for the first deployment).                        |
| AWS CLI v2                   | Used below to read stack outputs, attach policies and subscribe to topics. Not needed by `cdk deploy` itself.                                                                                                                                              |
| Region                       | Set `AWS_REGION` (or a region in the profile). The CDK app reads account and region from the CLI profile; the seed script and the admin CLI use the same chain.                                                                                            |
| `curl` (and optionally `jq`) | For the smoke tests.                                                                                                                                                                                                                                        |
| Docker (optional)            | Only for the integration tests (DynamoDB Local, OpenSearch). Deployment does **not** need Docker: Lambdas are bundled with the pinned local esbuild.                                                                                                       |

The AWS CDK CLI is a pinned dev dependency (`aws-cdk` in `packages/infra`); do not install it
globally. `cdk.json` lives in `packages/infra`, so CDK commands run through the infra workspace
scripts (`synth`, `deploy`, `diff`, `cdk`).

## Deploy step by step

The default environment is `dev` (stack prefix `OpenEstate-dev`, API stage `dev`, all resources
deleted with the stack). Replace `123456789012` and `eu-central-1` with your account and region.

1. **Clone and install.**

   ```bash
   git clone https://github.com/CuriousExile/open-estate.git
   cd open-estate
   node --version   # must be >= 22.22.3 (see Prerequisites)
   npm ci
   ```

2. **Build.** Compiles all TypeScript packages and the Angular SPA into
   `packages/frontend/dist/browser`, which the FrontendStack uploads.

   ```bash
   npm run build
   ```

3. **Test (recommended).** Unit and property tests need no AWS account and no Docker.

   ```bash
   npm test
   npm run synth   # validates config files and synthesizes all stacks, no AWS access needed
   ```

   Integration tests are optional and need Docker; see [CONTRIBUTING.md](../CONTRIBUTING.md#tests):

   ```bash
   docker run --rm -d --name dynamodb-local -p 8000:8000 amazon/dynamodb-local
   docker run --rm -d --name opensearch -p 9200:9200 -e discovery.type=single-node \
     -e DISABLE_SECURITY_PLUGIN=true -e OPENSEARCH_JAVA_OPTS="-Xms512m -Xmx512m" \
     opensearchproject/opensearch:2.19.2   # wait until http://localhost:9200 answers
   npm run test:integration
   docker stop dynamodb-local opensearch
   ```

4. **Select the account and region.**

   ```bash
   export AWS_PROFILE=my-profile      # or any other credential source
   export AWS_REGION=eu-central-1
   aws sts get-caller-identity        # confirms the account
   ```

5. **Bootstrap CDK** once per account and region (creates the `CDKToolkit` stack with the asset
   bucket and deployment roles):

   ```bash
   npx cdk bootstrap aws://123456789012/eu-central-1
   ```

6. **Deploy all stacks** of the `dev` environment:

   ```bash
   npm run deploy --workspace @open-estate/infra -- -c env=dev
   ```

   This runs `cdk deploy --all` and creates, in dependency order, `OpenEstate-dev-Data`,
   `-ManagementData`, `-Api`, `-Monitoring`, `-Ingestion`, `-Admin`, `-Frontend`, `-Identity` and
   `-Management` (plus `-Search` with [OpenSearch](#optional-opensearch-search-provider)). The
   `-Management` stack writes the frontend's `runtime-config.json` (Search_API URL plus the
   portal's Cognito and Management_API settings); pass `-c initialPlatformAdminEmail=<address>` to
   invite the first Plattform_Admin. CDK asks for confirmation before creating
   IAM roles and policies; for an unattended run append `--require-approval never`. The first
   deployment takes roughly 10–15 minutes, mostly for CloudFront.

7. **Note the stack outputs.** CDK prints them at the end; you can read them again at any time:

   ```bash
   output() {  # usage: output <stack-suffix> <output-key>
     aws cloudformation describe-stacks --stack-name "OpenEstate-dev-$1" \
       --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text
   }
   export API_URL=$(output Api ApiUrl)                       # ends with /dev/
   export FRONTEND_URL=$(output Frontend FrontendUrl)
   export OPEN_ESTATE_ADMIN_URL=$(output Admin AdminApiUrl)  # read by open-estate-admin
   export OPEN_ESTATE_RELOAD_FUNCTIONS=$(output Admin ReloadFunctionNames)
   ADMIN_POLICY_ARN=$(output Admin AdministratorPolicyArn)
   OVERDUE_TOPIC_ARN=$(output Admin OverdueTopicArn)
   ALARM_TOPIC_ARN=$(output Monitoring AlarmTopicArn)
   ```

   | Stack        | Output                                          | Used for                                                       |
   | ------------ | ----------------------------------------------- | -------------------------------------------------------------- |
   | `Api`        | `ApiUrl`                                        | Base URL of the Search API and the MCP server (`/mcp`)         |
   | `Frontend`   | `FrontendUrl`, `DistributionDomainName`         | The web frontend (CloudFront)                                  |
   | `Admin`      | `AdminApiUrl`                                   | `OPEN_ESTATE_ADMIN_URL` of the admin CLI                       |
   | `Admin`      | `AdministratorPolicyArn`                        | Managed policy to attach to administrators                     |
   | `Admin`      | `ReloadFunctionNames`                           | `OPEN_ESTATE_RELOAD_FUNCTIONS` of `open-estate-admin reload`   |
   | `Admin`      | `OverdueTopicArn`                               | Notifications about overdue deletion requests                  |
   | `Monitoring` | `AlarmTopicArn`, `DashboardName`                | Latency alarms and the CloudWatch dashboard                    |
   | `Data`       | `ListingsTableName`, `ConfigBucketName`         | Seed script; configuration files                               |
   | `Search`     | `CollectionEndpoint`, `IndexerDeadLetterQueueUrl` | Only with OpenSearch                                         |

8. **Seed the sample listings** (8 fictitious listings with source `seed`; re-running is
   idempotent). The script finds the table through the `ListingsTableName` output of
   `OpenEstate-<env>-Data`; `--table <name>` or `LISTINGS_TABLE_NAME` override the lookup.

   ```bash
   npm run seed --workspace @open-estate/infra -- --env dev
   # Seeded 8 listing(s) into OpenEstate-dev-Data-Listings…
   ```

9. **Verify the API.**

   ```bash
   curl -s "${API_URL}listings"                      # 200 with the seed listings (ids seed-…)
   curl -s "${API_URL}listings/seed-de-berlin-001"   # one listing
   curl -s "${API_URL}meta"                          # taxonomy, locales, default currency
   curl -s "${API_URL}openapi.json" | head -c 200    # machine-readable API description
   ```

   A `503 SERVICE_UNAVAILABLE` or `429 RATE_LIMITED` here is covered under
   [Troubleshooting](#troubleshooting).

10. **Open the frontend** at `$FRONTEND_URL` (`https://<id>.cloudfront.net`). The SPA reads the
    API URL from the generated `runtime-config.json`; branding comes from `theme-config.json`.

11. **Set up an administrator and the admin CLI.** The Admin API is IAM-authorized; every call is
    SigV4-signed with your AWS credentials. Attach the managed policy to the administrator's user
    or role:

    ```bash
    aws iam attach-user-policy --user-name alice --policy-arn "$ADMIN_POLICY_ARN"
    # or: aws iam attach-role-policy --role-name OpsAdmin --policy-arn "$ADMIN_POLICY_ARN"
    ```

    Then use the CLI (built in step 2; reference: [packages/admin/README.md](../packages/admin/README.md)):

    ```bash
    npx open-estate-admin create-key --expires-at 2027-01-01T00:00:00Z > key.json   # plaintext key shown once
    npx open-estate-admin set-access-mode api-keys      # applied within 60 s, no redeploy
    curl -s -H "Authorization: Bearer $(jq -r .apiKey key.json)" "${API_URL}listings"
    npx open-estate-admin set-access-mode open          # back to open access
    npx open-estate-admin set-rate-limit --requests 120 --window-seconds 60
    ```

    `key.json` contains a secret; keep it out of version control. The SPA sends no API key, so in
    `api-keys` mode the public frontend receives `401` — use that mode for agent-only deployments.

12. **Subscribe to notifications.** Subscriptions are not part of the stacks, so administrators can
    change without a deployment. Confirm each email subscription via the link AWS sends.

    ```bash
    # Operational alarms (p95 latency of API and MCP)
    aws sns subscribe --topic-arn "$ALARM_TOPIC_ARN" --protocol email \
      --notification-endpoint ops@example.org

    # Overdue deletion requests: one subscription per administrator, filtered on the IAM ARN
    # that requested the deletion (for assumed roles: arn:aws:sts::<account>:assumed-role/<role>/<session>)
    aws sns subscribe --topic-arn "$OVERDUE_TOPIC_ARN" --protocol email \
      --notification-endpoint admin@example.org \
      --attributes '{"FilterPolicy":"{\"adminArn\":[\"arn:aws:iam::123456789012:user/alice\"]}"}'
    ```

Connectors: the shipped `packages/shared/src/config/connectors.json` is empty, so the
IngestionStack deploys no schedules until you register a connector (see [connectors.md](connectors.md)).

## Optional: OpenSearch search provider

DynamoDB is the default search provider. For larger data sets, deploy an OpenSearch Serverless
collection plus the stream indexer:

```bash
npm run deploy --workspace @open-estate/infra -- -c env=dev -c searchProvider=opensearch
```

- This adds `OpenEstate-dev-Search`, enables the DynamoDB stream on `Listings` and switches the
  `search-provider` SSM parameter. Pass the same `-c searchProvider=opensearch` on every later
  `deploy`, `diff` and `destroy` of this environment.
- **Backfill:** the indexer only sees stream records written after the stream was enabled. Listings
  that existed before are not in the index until they are written again with a change (an
  unchanged `PutItem` emits no stream record). On a fresh environment, seed after this deployment.
  For existing data, re-run the import (connectors) or delete and re-seed the seed listings.
- Wait until the indexer's `IteratorAge` (dashboard `DashboardName`) is back at 0 before
  load-testing; see [packages/loadtest/README.md](../packages/loadtest/README.md).
- OpenSearch Serverless bills per OCU-hour even when idle; destroy test environments when done.
- To go back to DynamoDB: destroy `OpenEstate-<env>-Search` **first**, then deploy without the
  flag (the stream is exported to the Search stack).

## Production deployment

Any `env` other than `dev` is treated as long-lived:

```bash
npm run deploy --workspace @open-estate/infra -- -c env=prod
npm run seed --workspace @open-estate/infra -- --env prod   # only if you want the samples in prod
```

| Aspect                    | `dev`                        | `prod` (any env ≠ `dev`)                                                 |
| ------------------------- | ---------------------------- | ------------------------------------------------------------------------ |
| Stack names / API stage   | `OpenEstate-dev-*` / `dev`   | `OpenEstate-prod-*` / `prod`                                             |
| Removal policy            | `DESTROY`                    | `RETAIN` — tables, buckets and log groups survive a stack deletion       |
| DynamoDB tables           | no deletion protection       | deletion protection on (rate-limit counters excepted)                    |
| Config and site buckets   | emptied and deleted          | retained with their objects                                              |
| OpenSearch (if enabled)   | no standby replicas          | standby replicas (higher OCU cost)                                       |

Environment names must match `^[a-z][a-z0-9-]{0,15}$`. Several environments can live in one
account; each has its own SSM namespace `/open-estate/<env>/…`.

## End-to-end tests

`*.e2e.test.ts` in `packages/infra/test/e2e` test a deployed environment through its public
endpoints and AWS APIs: Search API answers within 5 s (Req 9.1), `RequestLatency` p95 queryable in
CloudWatch (11.4), unsigned `/admin/*` calls get 403 `FORBIDDEN` (18.11), a theme upload is served
within 5 s (8.2) and a new locale without rebuild (13.3). Every suite is skipped unless
`OPEN_ESTATE_E2E_ENV` is set, so `npm test` stays offline. Stack outputs and resources are looked
up by environment name; credentials and region come from the AWS SDK chain.

```bash
export AWS_PROFILE=my-profile AWS_REGION=eu-central-1
OPEN_ESTATE_E2E_ENV=e2e npm run test:e2e        # deploy first: npm run deploy … -- -c env=e2e
OPEN_ESTATE_E2E_ENV=e2e OPEN_ESTATE_E2E_FAULT_INJECTION=true npm run test:e2e   # + Req 9.5, 9.6
```

Use a dedicated environment, never a shared or production one:

- The frontend suite temporarily overwrites `theme-config.json` and `i18n-config.json` in the
  site bucket and adds `i18n/<locale>.json` (first free of `eo`, `ia`, `la`, `vo`); each test
  restores or deletes them afterwards. Concurrent users of the frontend see the test values.
- With `OPEN_ESTATE_E2E_FAULT_INJECTION=true`, the Search API Lambda gets
  `AWS_ENDPOINT_URL_DYNAMODB` set to an unresolvable and then to an unrouted endpoint; meanwhile
  every request answers 503. The suite writes the original environment back and waits until the
  API answers 200 again. If a run is killed in between, restore it with
  `npm run deploy --workspace @open-estate/infra -- -c env=e2e`.
- The metric test waits up to 6 minutes for CloudWatch to receive the EMF datapoints.
- The caller needs `cloudformation:DescribeStacks`/`ListStackResources`, `s3:GetObject`/
  `PutObject`/`DeleteObject` on the site bucket, `cloudwatch:GetMetricData` and, for fault
  injection, `lambda:GetFunctionConfiguration`/`UpdateFunctionConfiguration` and `dynamodb:GetItem`
  on the listings table.

## Teardown

**dev:** destroy all stacks; CDK removes them in reverse dependency order (Frontend, Admin,
Ingestion, Monitoring, Api, [Search], Data). Pass the same context as for the deployment:

```bash
npm run cdk --workspace @open-estate/infra -- destroy --all -c env=dev
# with OpenSearch: ... destroy --all -c env=dev -c searchProvider=opensearch
```

`destroy` synthesizes the app first, so it needs the frontend build output too (run
`npm run build` on a fresh checkout). CloudFront deletion can take several minutes.

**prod:** `destroy` removes the stacks but leaves the retained resources (DynamoDB tables with
deletion protection, the config and site buckets, log groups). Delete them manually only if you
really want to drop the data: disable deletion protection on each table
(`aws dynamodb update-table --table-name <name> --no-deletion-protection-enabled`), then delete
tables, empty and delete buckets. A new deployment with the same `env` creates new, empty
resources; it does not reattach the retained ones.

The CDK bootstrap stack (`CDKToolkit`) stays; it is shared by all CDK apps in the account.

## Configuration overrides

All settings are CDK context values: `-c key=value` on the command line (or `context` in
`packages/infra/cdk.json`). Invalid values abort synth with one message listing every problem.
Relative paths resolve against the working directory, which is `packages/infra` when you use the
workspace scripts.

| Key                  | Default                                      | Example                                              | Effect                                                                                              |
| -------------------- | -------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `env`                | `dev`                                        | `-c env=prod`                                        | Stack prefix, stage name, removal policy                                                            |
| `defaultCurrency`    | `EUR`                                        | `-c defaultCurrency=THB`                             | Initial SSM `default-currency` (ISO 4217)                                                           |
| `accessMode`         | `open`                                       | `-c accessMode=api-keys`                             | Initial SSM `access-mode`; change at runtime with `set-access-mode`                                 |
| `rateLimit`          | `{"requests":60,"windowSeconds":60}`         | `-c rateLimit='{"requests":300,"windowSeconds":60}'` | Initial SSM `rate-limit` (1–10000 requests, 1–3600 s); change at runtime with `set-rate-limit`      |
| `searchProvider`     | `dynamodb`                                   | `-c searchProvider=opensearch`                       | Adds the Search stack and the stream indexer                                                        |
| `configDir`          | `packages/shared/src/config`                 | `-c configDir=../../my-config`                       | Directory validated and uploaded to the config bucket (taxonomy, allowlists, `connectors.json`)     |
| `i18nConfigFile`     | `packages/frontend/public/i18n-config.json`  | `-c i18nConfigFile=../../my-config/i18n.json`        | Enabled locales, shared by frontend, API and MCP                                                    |
| `wafRateLimit`       | `2000`                                       | `-c wafRateLimit=5000`                               | WAF block threshold per IP and 5 minutes (10–2,000,000,000)                                          |
| `corsAllowedOrigins` | none                                         | `-c corsAllowedOrigins=http://localhost:4200`        | Extra browser origins besides the CloudFront origin (comma-separated, no path, no `*`)             |
| `frontendAssetDir`   | `packages/frontend/dist/browser`             | `-c frontendAssetDir=../frontend/dist/browser`       | Built SPA to upload (must contain `index.html`)                                                     |
| `frontendPriceClass` | `PriceClass_100`                             | `-c frontendPriceClass=PriceClass_All`               | CloudFront edge locations                                                                           |
| `logLevel`           | `INFO`                                       | `-c logLevel=WARN`                                   | Powertools log level of every runtime Lambda (`DEBUG`, `INFO`, `WARN`, `ERROR`, `CRITICAL`, `SILENT`); raise it to cut CloudWatch Logs volume |
| `metricsDisabled`    | `false`                                      | `-c metricsDisabled=true`                            | `true` stops the per-request `RequestLatency` EMF metric on every Lambda. Also removes the data behind the latency alarms and dashboard, so keep it off for monitored environments |

The SSM parameters (`/open-estate/<env>/default-currency`, `access-mode`, `rate-limit`,
`search-provider`, `config-bucket`) receive the context value when CloudFormation creates or
changes them. Values set later with `open-estate-admin` stay until a deployment changes that
parameter's template value, so keep context and runtime settings consistent.

Taxonomy and allowlist changes in `configDir` reach the config bucket with the next deployment.
Functions load them only at init, and a deployment that changes only config files does not
restart them: run `npx open-estate-admin reload` (uses `OPEN_ESTATE_RELOAD_FUNCTIONS`) afterwards,
or after editing files in the bucket directly.

## Troubleshooting

Each entry: **symptom → cause → fix.** API errors always have the body
`{"errors":[{"code":"…","message":"…"}]}`; the `code` identifies the case.

**Finding Lambda logs.** All functions log JSON lines (`level`, `message`, fields). The Search API
and MCP function names are in the `ReloadFunctionNames` output; their logs are in
`/aws/lambda/<function name>`. Example:

```bash
aws logs tail "/aws/lambda/$(echo "$OPEN_ESTATE_RELOAD_FUNCTIONS" | cut -d, -f1)" --since 1h
```

### `cdk synth`/`deploy` fails with `ConfigDirectoryError`

- **Symptom:** `ConfigDirectoryError: Invalid configuration in <dir>:` followed by one line per
  problem, e.g. `taxonomy.json: missing`, `taxonomy.json: <violation> "<code>": …`,
  `foo.json: unknown config file (known: …)`, `connectors.json: invalid JSON (…)`,
  `i18n-config.json: mirrored from …; remove it from the config directory`,
  `cannot read directory: …`.
- **Cause:** a file in `configDir` (default `packages/shared/src/config`) fails the schema its
  runtime uses. Synth validates every file before creating anything, so a broken taxonomy,
  tour/crawler/PII allowlist or `connectors.json` never reaches AWS.
- **Fix:** correct each listed file and line; the path after the file name (e.g.
  `groups.0.types`) points to the offending field. Only known files are allowed;
  `i18n-config.json` must not be in `configDir` (it comes from `i18nConfigFile`). Check that a
  relative `-c configDir=…` is relative to `packages/infra`. Re-run `npm run synth`.

### `cdk synth`/`deploy` fails with `FrontendConfigError`

- **Symptom:** `FrontendConfigError: Invalid frontend configuration:` with e.g.
  `i18n-config.json: cannot read …`, `i18n-config.json: defaultLocale: …` or
  `translation file of the default locale "en": missing …/i18n/en.json`.
- **Cause:** `i18n-config.json` or the translation file of the **default** locale is missing or
  invalid (translation files are flat objects of key → string). A broken file of another enabled
  locale is only a synth warning; that locale is hidden in the SPA.
- **Fix:** repair the named file in `packages/frontend/public/` (or the file given by
  `i18nConfigFile`), rebuild with `npm run build`, deploy again. A CSP length error
  (`Content-Security-Policy would be ~N characters`) means the tour allowlist has too many/long
  host names; shorten `tour-providers.json`.

### `frontend build output not found`

- **Symptom:** `FrontendConfigError` with `frontend build output not found:
  …/packages/frontend/dist/browser/index.html` and the hint to run `npm run build` — also on
  `cdk destroy`.
- **Cause:** the SPA was not built (fresh clone, `npm run clean`, failed `ng build`), or
  `frontendAssetDir` points elsewhere.
- **Fix:** `npm run build` (check that it finished without the Node version error below), or pass
  the correct `-c frontendAssetDir=<dir>`.

### Node version errors

- **Symptom:** `npm run build` stops with `Node.js version v20.x detected. The Angular CLI
  requires a minimum Node.js version of v22.22.3 or v24.15.0 or v26.0.0.`; `npm ci` may print
  `EBADENGINE` warnings.
- **Cause:** Angular 22 needs a newer Node than the backend packages.
- **Fix:** install Node 22.22.3+ (or 24.15+), e.g. `nvm install 22 && nvm use 22`, then
  `npm ci && npm run build`.

### CDK bootstrap missing

- **Symptom:** `deploy` fails with `This stack uses assets, so the toolkit stack must be deployed
  to the environment` or `SSM parameter /cdk-bootstrap/hnb659fds/version not found. Has the
  environment been bootstrapped?`
- **Cause:** step 5 was skipped for this account/region, or `AWS_REGION`/profile point to another
  region than the one bootstrapped.
- **Fix:** `npx cdk bootstrap aws://<account>/<region>` for the region you deploy to.

### All API requests return `503 SERVICE_UNAVAILABLE`

- **Symptom:** every request to `/listings`, `/meta` etc. answers 503 with
  `{"errors":[{"code":"SERVICE_UNAVAILABLE","message":"Service unavailable."}]}`.
- **Cause:** the function's init failed. Configuration errors are final for that Lambda instance;
  the response deliberately contains no details. The log line
  `Search API: init failed` (MCP: `POST /mcp: init failed`) has `code` `CONFIG_MISSING` (missing or
  empty environment variable, SSM parameter or config-bucket file; `names` lists all of them) or
  `CONFIG_INVALID` (value present but invalid; `issues` gives the path), or a
  `TaxonomyValidationError` with `violations`.
- **Fix:**
  1. Find the line: `aws logs tail /aws/lambda/<ListingsFunction name> --since 1h --filter-pattern '"init failed"'`.
  2. Missing SSM value → check `aws ssm get-parameters-by-path --path /open-estate/<env>/`;
     missing file → `aws s3 ls s3://<ConfigBucketName>/`; missing environment variable → the
     function was changed outside CDK. Redeploying (`npm run deploy …`) restores all three.
  3. Invalid value (e.g. `rate-limit` edited by hand) → correct it with `open-estate-admin
     set-rate-limit` / `set-access-mode` or `aws ssm put-parameter --overwrite`.
  4. Restart the functions so new instances start: `npx open-estate-admin reload`.
- If the log shows no init error, look for `GET /listings: request failed` with `errorName`: a
  downstream service (DynamoDB, OpenSearch) failed or exceeded 10 s; check the dashboard.

### `429 RATE_LIMITED`

Three layers can answer 429; the body and headers tell them apart:

| Source              | `message`                                         | `Retry-After` / `retryAfterSeconds` | Limit and fix                                                                                         |
| ------------------- | ------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------- |
| AccessGuard         | `Rate limit of N requests per W s exceeded`       | seconds until the window ends       | Per client (IP in `open` mode, key in `api-keys` mode). `set-rate-limit` or `set-key-rate-limit`; effective within 60 s |
| WAF                 | `Too many requests from this IP address.`         | none                                | `wafRateLimit` per IP and 5 min (default 2000). Redeploy with `-c wafRateLimit=<n>`; wait up to 5 min  |
| API Gateway stage   | `Too many requests.`                              | `1`                                 | 100 req/s, burst 200 for the whole stage (Admin API: 10/20). Reduce load or raise in `api-stack.ts`    |

The WAF response carries CORS headers only for `corsAllowedOrigins`, so from the CloudFront SPA the
browser may report it as a CORS error; check the status in the network tab.

### `401 API_KEY_MISSING` / `401 API_KEY_INVALID`

- **Cause:** access mode is `api-keys` and the request has no `Authorization` header, or the key is
  unknown, revoked, expired or not sent as `Authorization: Bearer <key>`. Key lookups are cached
  for up to 60 s, so a just-created key or a mode change can take a minute.
- **Fix:** send `Authorization: Bearer <apiKey>` with a key from `open-estate-admin create-key`;
  create a new key if it expired or was revoked. If the public frontend should work, switch back
  with `open-estate-admin set-access-mode open` (the SPA sends no key).

### `403 FORBIDDEN` on the Admin API

- **Symptom:** `open-estate-admin` exits with `403` and `{"errors":[{"code":"FORBIDDEN","message":"Access denied."}]}`.
- **Cause:** the request is unsigned (e.g. plain `curl`), signed for another region or with expired
  credentials, or the caller lacks `execute-api:Invoke` on `/admin/*` because
  `AdministratorPolicyArn` is not attached. Unknown paths answer 403 as well.
- **Fix:** attach the policy (step 11), refresh credentials (`aws sso login`), check
  `aws sts get-caller-identity` and that `OPEN_ESTATE_ADMIN_URL` includes the stage
  (`…/dev`). `reload` failures name `lambda:GetFunctionConfiguration`/`UpdateFunctionConfiguration`
  — also granted by that policy.

### CORS errors in the browser

- **Symptom:** the SPA shows a load error; the console reports a missing
  `Access-Control-Allow-Origin` header. The function log may contain
  `Search API: no CORS origin configured, browser clients cannot read responses`.
- **Cause:** the Search API reads the allowed origin from the SSM parameter
  `/open-estate/<env>/frontend-origin` at init. The Frontend stack writes it **after** the Api stack
  is deployed, so instances that started before (first deployment, early cold starts) keep an
  empty allowlist. A different origin (custom domain, `ng serve` on `localhost:4200`) is not
  allowed unless listed.
- **Fix:** check `aws ssm get-parameter --name /open-estate/<env>/frontend-origin`; then
  `npx open-estate-admin reload` so new instances load it. For other origins redeploy with
  `-c corsAllowedOrigins=https://homes.example.com,http://localhost:4200`.

### Search results stale with OpenSearch

- **Symptom:** new or changed listings are found by `GET /listings/{id}` but not (or outdated) in
  search results; deleted listings still appear.
- **Cause:** the indexer lags behind the DynamoDB stream (`IteratorAge` high, e.g. after a bulk
  import) or gave up on batches, which then land in the dead-letter queue
  (`IndexerDeadLetterQueueUrl`, metadata only: shard and sequence range). Listings written before
  OpenSearch was enabled were never indexed (see [backfill](#optional-opensearch-search-provider)).
- **Fix:** watch `IteratorAge` and indexer errors on the dashboard; inspect the indexer log
  (`/aws/lambda/OpenEstate-<env>-Search-IndexerFunction…`). For DLQ messages
  (`aws sqs receive-message --queue-url <IndexerDeadLetterQueueUrl>`), fix the cause and re-write
  the affected listings (re-import, or re-seed for seed data) so they produce new stream records.

### 3D tours are not embedded

- **Symptom:** a listing has tours, but the detail page shows none; the browser console logs the
  hidden tour with listing id and host, or a CSP `frame-src` violation.
- **Cause:** tours are default-deny. Only hosts in `tour-providers.json` are embedded, and the
  shipped file is empty (`{"providers":[]}`), so the seed listings' Matterport tours are hidden.
  The allowlist feeds `/meta.tourProviders`, the API filter and the CloudFront CSP `frame-src`.
- **Fix:** add the provider to `tour-providers.json` in `configDir`, e.g.
  `{"providers":[{"code":"matterport","hostnames":["my.matterport.com"]}]}`, redeploy (updates the
  bucket and the CSP), then `npx open-estate-admin reload`. Check with `curl -s "${API_URL}meta"`.

### Connector run times out or ends in `FAILURE`

- **Symptom:** no new listings from a connector; the Step Functions execution of
  `Connector run: <id>` is `TIMED_OUT` or `FAILED` with error `ConnectorRunFailed`.
- **Cause:** the run exceeded `timeoutSeconds` from `connectors.json` (same value for execution and
  Lambda, max 900 s), or the connector finished with run status `FAILURE` (for example an
  unreachable source or a missing secret; the run log names the reason).
- **Fix:**
  1. Open the state machine (resources are tagged `open-estate:connector=<id>`) and its execution
     history: `aws stepfunctions list-executions --state-machine-arn <arn> --status-filter FAILED`.
  2. The execution name is the run id. Search the connector function's log for it — the run log
     lists rejected records with field and reason, crawl checks and the summary counters.
  3. Fix source, secret (`secretRef`) or allowlist; raise `timeoutSeconds` (≤ 900) or split the
     source; redeploy. A manual run:
     `aws stepfunctions start-execution --state-machine-arn <arn> --input '{"connectorId":"<id>"}'`.

### Deletion request stays `OPEN`

- **Symptom:** `open-estate-admin get-deletion <requestId>` still shows `status: OPEN`; after 24 h
  the requester receives an overdue notification (only if subscribed with their ARN, step 12).
- **Cause:** the deletion workflow execution (named after the request id) failed or is still
  retrying transient errors; it stops after 24 h and the request stays `OPEN`.
- **Fix:** find the execution:
  `aws stepfunctions describe-execution --execution-arn arn:aws:states:<region>:<account>:execution:<deletion state machine name>:<requestId>`
  (state machine name: `aws stepfunctions list-state-machines`) and read the failed state's error.
  After fixing the cause, submit the deletion again with `open-estate-admin request-deletion`.

### Integration tests skipped or fail to connect

- **Symptom:** `npm run test:integration` fails with `ECONNREFUSED localhost:8000` / `:9200`, or
  suites are skipped.
- **Cause:** Docker is not installed/running, or the DynamoDB Local / OpenSearch containers are not
  up yet (OpenSearch needs ~30 s). Suites are skipped when `DYNAMODB_ENDPOINT` /
  `OPENSEARCH_ENDPOINT` are unset (plain `npm test`).
- **Fix:** install and start Docker, start both containers (step 3), wait until
  `curl http://localhost:9200` answers, then rerun. Deployment itself never needs Docker.

### Leftover `cdk.out`

Not a failure: `packages/infra/cdk.out` is regenerated on every synth and ignored by git. Deleting
it is safe but never required.
