import * as path from 'node:path';
import { ArnFormat, CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import {
  EndpointType,
  LambdaIntegration,
  ResponseType,
  RestApi,
  type IResource,
} from 'aws-cdk-lib/aws-apigateway';
import type { ITableV2 } from 'aws-cdk-lib/aws-dynamodb';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import type { IBucket } from 'aws-cdk-lib/aws-s3';
import { CfnWebACL, CfnWebACLAssociation } from 'aws-cdk-lib/aws-wafv2';
import {
  CORS_CONFIG_VALUES,
  CORS_ENV,
  CORS_EXPOSED_HEADERS,
  LISTINGS_ROUTES,
} from '@open-estate/api';
import {
  AGENCIES_BY_STATE_INDEX,
  CONFIG_BUCKET_ENV,
  DEFAULT_METRICS_NAMESPACE,
  LISTINGS_BY_ID_INDEX,
  MCP_REQUEST_DEADLINE_MS,
  READ_MODEL_CONFIG_FILES,
  READ_MODEL_ENV,
  SSM_PARAMETER_SUFFIX,
} from '@open-estate/core';
import type { ErrorCode, ErrorResponse } from '@open-estate/shared';
import type { Construct } from 'constructs';
import {
  DEFAULT_OBSERVABILITY_SETTINGS,
  POWERTOOLS_LOG_LEVEL_ENV,
  POWERTOOLS_METRICS_DISABLED_ENV,
  WAF_RATE_LIMIT_WINDOW_SECONDS,
  type ObservabilitySettings,
  type SearchProviderKind,
} from './config';
import { API_KEYS_BY_HASH_INDEX, type SsmParameterKey, type SsmParameterNames } from './data-stack';
import {
  addIndexAccessPolicy,
  grantCollectionApiAccess,
  READER_INDEX_PERMISSIONS,
  roleOf,
  type SearchIndexRef,
} from './opensearch-access';

// Same relative depth from `src/` (ts) and `dist/` (compiled js).
const REPO_ROOT = path.resolve(__dirname, '../../..');
const API_PACKAGE = path.join(REPO_ROOT, 'packages/api');
const MCP_PACKAGE = path.join(REPO_ROOT, 'packages/mcp');

// Downstream calls run with a 4.5 s deadline (design: Observability); 5 s caps the whole invocation
// at the Req 9.1 response limit instead of API Gateway's 29 s integration default.
const LAMBDA_TIMEOUT = Duration.seconds(5);

// The MCP handler aborts itself after MCP_REQUEST_DEADLINE_MS (Req 19.10) and answers with a
// JSON-RPC error; the Lambda timeout must lie above it so that answer is still sent, and below
// API Gateway's 29 s integration timeout.
const MCP_LAMBDA_TIMEOUT = Duration.millis(MCP_REQUEST_DEADLINE_MS + 2_000);

/**
 * EMF namespace of `RequestLatency` and `RequestCount`, set on the API and MCP Lambda alike; the
 * alarms of task 19.2 and the platform monitoring (Req 14.1) read the same namespace. EMF goes
 * through the function's log stream, so no `cloudwatch:PutMetricData` permission is needed.
 */
export const METRICS_NAMESPACE = DEFAULT_METRICS_NAMESPACE;

/** Streamable HTTP endpoint of the MCP_Server (design: "API-Zugang"). */
export const MCP_ROUTE = '/mcp';

/**
 * Methods routed to the MCP Lambda. Only `POST` carries MCP messages; `GET` (SSE stream) and
 * `DELETE` (session end) are part of Streamable HTTP and are answered by the stateless handler
 * with the spec-conformant 405 + `Allow: POST`, which clients use to detect that no stream or
 * session exists. Without these methods the gateway would answer 404 NOT_FOUND. Not `ANY`: other
 * methods are not part of the transport and stay with the gateway's 404.
 */
export const MCP_METHODS = ['POST', 'GET', 'DELETE'] as const;

/** Methods of every {@link LISTINGS_ROUTES} route; `OPTIONS` is the CORS preflight. */
export const LISTINGS_METHODS = ['GET', 'OPTIONS'] as const;

// Moderate stage-wide defaults, above the 50 req/s reference load (Req 11.3). Per-key limits are
// enforced in Lambda (AccessGuard, Req 17), WAF covers floods.
const THROTTLING_RATE_LIMIT = 100;
const THROTTLING_BURST_LIMIT = 200;

/**
 * SSM values a runtime function reads, with the logical name it uses: `<NAME>_SSM_PARAMETER`
 * (ConfigProvider) or the parameter options of `SsmAccessConfigSource`. The bucket name itself is
 * passed directly as `CONFIG_BUCKET`, so the `config-bucket` parameter is not needed at runtime.
 */
export const RUNTIME_SSM_VALUES: Readonly<Partial<Record<SsmParameterKey, string>>> = {
  defaultCurrency: 'DEFAULT_CURRENCY',
  searchProvider: 'SEARCH_PROVIDER',
  accessMode: 'ACCESS_MODE',
  rateLimit: 'RATE_LIMIT',
};

/** External configuration of the runtime (Req 9.3, 11.1), provided by the DataStack. */
export interface RuntimeConfig {
  readonly configBucket: IBucket;
  readonly parameterNames: SsmParameterNames;
}

/**
 * Browser origins of the Search_API (design: "Search_API", CORS). The frontend origin is read by
 * the Lambda from SSM at init, because the FrontendStack depends on the API URL and a reference in
 * the other direction would be a cycle.
 */
export interface ApiCorsProps {
  /** SSM parameter written by the FrontendStack (`frontendOriginParameterName`). */
  readonly frontendOriginParameter: string;
  /** Additional normalized origins (context `corsAllowedOrigins`). */
  readonly allowedOrigins: readonly string[];
}

/** Tables of the read side (`initReadModel`): search/detail, the AccessGuard and suspensions. */
export interface ReadModelTables {
  readonly listings: ITableV2;
  readonly apiKeys: ITableV2;
  readonly rateLimitCounters: ITableV2;
  /** `Agencies` of the ManagementDataStack; GSI `byState` yields the suspended agencies (Req 1.9). */
  readonly agencies: ITableV2;
}

/**
 * OpenSearch target of the read side, provided by the optional SearchStack. The ApiStack grants
 * its own roles access (IAM and a data access policy of its own), so the SearchStack needs no
 * reference to them.
 */
export interface OpenSearchTarget extends SearchIndexRef {
  readonly endpoint: string;
}

export interface ApiStackProps extends StackProps {
  readonly tables: ReadModelTables;
  readonly config: RuntimeConfig;
  readonly cors: ApiCorsProps;
  readonly stageName: string;
  readonly removalPolicy: RemovalPolicy;
  /** Initial `search-provider`; `opensearch` requires {@link openSearch}. */
  readonly searchProvider: SearchProviderKind;
  readonly openSearch?: OpenSearchTarget;
  /** Requests per IP and {@link WAF_RATE_LIMIT_WINDOW_SECONDS} before WAF blocks. */
  readonly wafRateLimit: number;
  /** Log level and metrics toggle applied to the Listings and MCP Lambdas. */
  readonly observability: ObservabilitySettings;
}

/**
 * Gateway errors (unknown route, throttling, WAF, integration failure) in the `ErrorResponse`
 * format with catalog codes (Req 3.4). `statusCode` is only set where the gateway default differs
 * from the catalog; it is never set on DEFAULT_4XX/5XX, which would override every other type.
 */
export const GATEWAY_RESPONSES: readonly {
  type: ResponseType;
  statusCode?: number;
  code: ErrorCode;
  message: string;
  retryAfterSeconds?: number;
}[] = [
  // REST APIs answer an unknown resource or method with MISSING_AUTHENTICATION_TOKEN (403).
  {
    type: ResponseType.MISSING_AUTHENTICATION_TOKEN,
    statusCode: 404,
    code: 'NOT_FOUND',
    message: 'No such resource.',
  },
  {
    type: ResponseType.RESOURCE_NOT_FOUND,
    statusCode: 404,
    code: 'NOT_FOUND',
    message: 'No such resource.',
  },
  { type: ResponseType.ACCESS_DENIED, code: 'FORBIDDEN', message: 'Access denied.' },
  { type: ResponseType.INVALID_SIGNATURE, code: 'FORBIDDEN', message: 'Access denied.' },
  { type: ResponseType.EXPIRED_TOKEN, code: 'FORBIDDEN', message: 'Access denied.' },
  { type: ResponseType.WAF_FILTERED, code: 'FORBIDDEN', message: 'Request blocked.' },
  // Stage throttling is a token bucket refilled every second.
  {
    type: ResponseType.THROTTLED,
    code: 'RATE_LIMITED',
    message: 'Too many requests.',
    retryAfterSeconds: 1,
  },
  {
    type: ResponseType.INTEGRATION_FAILURE,
    statusCode: 503,
    code: 'SERVICE_UNAVAILABLE',
    message: 'Service unavailable.',
  },
  {
    type: ResponseType.INTEGRATION_TIMEOUT,
    statusCode: 503,
    code: 'SERVICE_UNAVAILABLE',
    message: 'Service unavailable.',
  },
  { type: ResponseType.DEFAULT_4XX, code: 'INVALID_PARAMETER', message: 'Invalid request.' },
  { type: ResponseType.DEFAULT_5XX, code: 'SERVICE_UNAVAILABLE', message: 'Service unavailable.' },
];

/** WAF rate-rule answer, same format as the AccessGuard's 429 (without an exact wait time). */
const WAF_RATE_LIMITED_BODY: ErrorResponse = {
  errors: [{ code: 'RATE_LIMITED', message: 'Too many requests from this IP address.' }],
};

/**
 * Public Search_API: API Gateway REST API, one Lambda-proxy function for all read routes
 * (`LISTINGS_ROUTES`), gateway errors in the `ErrorResponse` format and a WAF WebACL with a static
 * per-IP rate rule. No gateway request validation: the shared Zod schema in Lambda is the only
 * schema source (design: "API-Zugang", Req 3.4). The MCP_Server runs as a second Lambda behind
 * {@link MCP_ROUTE} on the same API, stage, throttling and WAF.
 */
export class ApiStack extends Stack {
  readonly api: RestApi;
  readonly listingsFunction: NodejsFunction;
  readonly mcpFunction: NodejsFunction;
  readonly webAcl: CfnWebACL;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);
    if (props.searchProvider === 'opensearch' && props.openSearch === undefined) {
      throw new Error('searchProvider "opensearch" requires an OpenSearch target (SearchStack)');
    }

    this.listingsFunction = readModelFunction(this, 'ListingsFunction', {
      description: 'Search_API GET /listings, /listings/{id}, /openapi.json, /meta, /locations',
      packageDir: API_PACKAGE,
      entry: 'src/listings.ts',
      memorySize: 512,
      timeout: LAMBDA_TIMEOUT,
      removalPolicy: props.removalPolicy,
      observability: props.observability,
    });
    grantReadModel(this.listingsFunction, props);
    grantCorsConfig(this.listingsFunction, props.cors);

    // Same read model, AccessGuard tables and configuration as the API (Req 17.1, 19.7). More
    // memory than the API: the MCP SDK makes the bundle and its cold start larger, and Lambda
    // CPU scales with memory.
    this.mcpFunction = readModelFunction(this, 'McpFunction', {
      description: 'MCP_Server POST /mcp (Streamable HTTP, stateless JSON)',
      packageDir: MCP_PACKAGE,
      entry: 'src/mcp.ts',
      memorySize: 768,
      timeout: MCP_LAMBDA_TIMEOUT,
      removalPolicy: props.removalPolicy,
      observability: props.observability,
    });
    grantReadModel(this.mcpFunction, props);
    if (props.openSearch !== undefined) {
      addIndexAccessPolicy(this, 'SearchIndexAccessPolicy', {
        name: `${props.openSearch.collectionName}-api`,
        description: 'Search API and MCP Lambda: query the listings index',
        target: props.openSearch,
        principals: [roleOf(this.listingsFunction), roleOf(this.mcpFunction)],
        permissions: READER_INDEX_PERMISSIONS,
      });
    }

    this.api = new RestApi(this, 'SearchApi', {
      restApiName: `${id}-search`,
      description: 'Open Estate Search_API',
      endpointTypes: [EndpointType.REGIONAL],
      cloudWatchRole: false,
      deployOptions: {
        stageName: props.stageName,
        throttlingRateLimit: THROTTLING_RATE_LIMIT,
        throttlingBurstLimit: THROTTLING_BURST_LIMIT,
      },
    });
    // OPTIONS: CORS preflight (only with `Authorization`, API-key mode), answered by the Lambda
    // from the same allowlist as the GET responses. MCP serves agents, not browsers: no CORS.
    for (const route of Object.values(LISTINGS_ROUTES)) {
      for (const method of LISTINGS_METHODS) {
        addLambdaRoute(this.api, method, route, this.listingsFunction);
      }
    }
    // Lambda proxy passes method, headers (Accept, Content-Type, Mcp-*) and body unchanged; MCP
    // messages are JSON text, so no binary media types are needed.
    for (const method of MCP_METHODS) {
      addLambdaRoute(this.api, method, MCP_ROUTE, this.mcpFunction);
    }
    addGatewayResponses(this.api, GATEWAY_RESPONSES, gatewayCorsHeaders(props.cors.allowedOrigins));

    const wafCorsHeaders = Object.entries(staticCorsHeaders(props.cors.allowedOrigins)).map(
      ([name, value]) => ({ name, value }),
    );
    this.webAcl = new CfnWebACL(this, 'SearchApiWebAcl', {
      name: `${id}-search`,
      // Allowed: [A-Za-z0-9+=:#@/,.-] and spaces. Coarse flood protection, not the Req 17 rate limit.
      description: 'Per-IP flood protection of the Search API',
      scope: 'REGIONAL',
      defaultAction: { allow: {} },
      visibilityConfig: visibility(`${id}-search`),
      customResponseBodies: {
        rateLimited: {
          contentType: 'APPLICATION_JSON',
          content: JSON.stringify(WAF_RATE_LIMITED_BODY),
        },
      },
      rules: [
        {
          name: 'ip-rate-limit',
          priority: 0,
          statement: {
            rateBasedStatement: {
              aggregateKeyType: 'IP',
              limit: props.wafRateLimit,
              evaluationWindowSec: WAF_RATE_LIMIT_WINDOW_SECONDS,
            },
          },
          action: {
            block: {
              customResponse: {
                responseCode: 429,
                customResponseBodyKey: 'rateLimited',
                ...(wafCorsHeaders.length > 0 && { responseHeaders: wafCorsHeaders }),
              },
            },
          },
          visibilityConfig: visibility(`${id}-ip-rate-limit`),
        },
      ],
    });
    new CfnWebACLAssociation(this, 'SearchApiWebAclAssociation', {
      resourceArn: this.api.deploymentStage.stageArn,
      webAclArn: this.webAcl.attrArn,
    });

    new CfnOutput(this, 'ApiUrl', {
      description: 'Base URL of the Search_API stage',
      value: this.api.url,
    });
  }
}

/** Options of {@link bundledFunction}. */
export type BundledFunctionOptions = Parameters<typeof bundledFunction>[2];

/**
 * {@link bundledFunction} of the read side, with the EMF namespace. The read-model variables are
 * added by {@link grantReadModel}.
 */
function readModelFunction(
  scope: Construct,
  id: string,
  options: BundledFunctionOptions,
): NodejsFunction {
  const fn = bundledFunction(scope, id, options);
  fn.addEnvironment('POWERTOOLS_METRICS_NAMESPACE', METRICS_NAMESPACE);
  return fn;
}

/**
 * Powertools log/metrics environment for a runtime function. The log level is always set so the
 * deployed value is explicit; `POWERTOOLS_METRICS_DISABLED` is only set when metrics are off (its
 * mere presence with `true` suppresses EMF). Defaults to INFO with metrics on.
 */
export function observabilityEnvironment(
  observability: ObservabilitySettings = DEFAULT_OBSERVABILITY_SETTINGS,
): Record<string, string> {
  return {
    [POWERTOOLS_LOG_LEVEL_ENV]: observability.logLevel,
    ...(observability.metricsDisabled && { [POWERTOOLS_METRICS_DISABLED_ENV]: 'true' }),
  };
}

/**
 * Bundled Node.js 22 Lambda (arm64, local esbuild, CJS, pinned AWS SDK bundled) with its own log
 * group (one month retention). Shared by the read side and the admin stack.
 */
export function bundledFunction(
  scope: Construct,
  id: string,
  options: {
    description: string;
    /** Package directory; `entry` and the package's `tsconfig.json` are resolved against it. */
    packageDir: string;
    entry: string;
    memorySize: number;
    timeout: Duration;
    removalPolicy: RemovalPolicy;
    /** Retries of asynchronous invocations; Lambda default (2) if omitted. */
    retryAttempts?: number;
    /** Powertools log level and metrics toggle; defaults (INFO, metrics on) if omitted. */
    observability?: ObservabilitySettings;
  },
): NodejsFunction {
  const logGroup = new LogGroup(scope, `${id}Logs`, {
    retention: RetentionDays.ONE_MONTH,
    removalPolicy: options.removalPolicy,
  });
  return new NodejsFunction(scope, id, {
    description: options.description,
    entry: path.join(options.packageDir, options.entry),
    handler: 'handler',
    projectRoot: REPO_ROOT,
    depsLockFilePath: path.join(REPO_ROOT, 'package-lock.json'),
    runtime: Runtime.NODEJS_22_X,
    architecture: Architecture.ARM_64,
    memorySize: options.memorySize,
    timeout: options.timeout,
    logGroup,
    ...(options.retryAttempts !== undefined && { retryAttempts: options.retryAttempts }),
    environment: {
      NODE_OPTIONS: '--enable-source-maps',
      ...observabilityEnvironment(options.observability),
    },
    bundling: {
      // Local esbuild (pinned devDependency), never Docker.
      forceDockerBundling: false,
      format: OutputFormat.CJS,
      target: 'node22',
      minify: true,
      sourceMap: true,
      tsconfig: path.join(options.packageDir, 'tsconfig.json'),
      // Bundle the pinned AWS SDK instead of relying on the runtime-provided version.
      externalModules: [],
    },
  });
}

function visibility(metricName: string): CfnWebACL.VisibilityConfigProperty {
  return {
    cloudWatchMetricsEnabled: true,
    sampledRequestsEnabled: true,
    // WAF metric names allow only [A-Za-z0-9_-].
    metricName: metricName.replace(/[^A-Za-z0-9_-]/g, '-'),
  };
}

/** Wires `method path` (resource template, e.g. `/listings/{id}`) as Lambda proxy integration. */
export function addLambdaRoute(
  api: RestApi,
  method: string,
  route: string,
  fn: NodejsFunction,
): void {
  let resource: IResource = api.root;
  for (const part of route.split('/').filter((p) => p !== '')) {
    resource = resource.getResource(part) ?? resource.addResource(part);
  }
  resource.addMethod(method, new LambdaIntegration(fn, { proxy: true }));
}

/** One gateway error mapped to the `ErrorResponse` format. */
export type GatewayResponseMapping = (typeof GATEWAY_RESPONSES)[number];

/**
 * CORS headers of the responses API Gateway and WAF produce without the Lambda (throttling, WAF
 * block, unknown route). They are static: they cannot pick the request origin from an allowlist,
 * and echoing `method.request.header.Origin` would allow every origin. So only a single origin
 * known at synth (context `corsAllowedOrigins`, e.g. the custom domain) is set; otherwise none,
 * and the SPA sees these rare errors as network errors (its generic error message).
 */
export function staticCorsHeaders(allowedOrigins: readonly string[]): Record<string, string> {
  const [origin, ...more] = allowedOrigins;
  if (origin === undefined || more.length > 0) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Expose-Headers': CORS_EXPOSED_HEADERS.join(', '),
    Vary: 'Origin',
  };
}

/** {@link staticCorsHeaders} as gateway-response mapping literals (single-quoted). */
export function gatewayCorsHeaders(allowedOrigins: readonly string[]): Record<string, string> {
  return Object.fromEntries(
    Object.entries(staticCorsHeaders(allowedOrigins)).map(([name, value]) => [name, `'${value}'`]),
  );
}

/** Adds each mapping as gateway response (`Cache-Control: no-store`, optional `Retry-After`). */
export function addGatewayResponses(
  api: RestApi,
  responses: readonly GatewayResponseMapping[] = GATEWAY_RESPONSES,
  /** Extra header mapping literals of every response, e.g. {@link gatewayCorsHeaders}. */
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  for (const { type, statusCode, code, message, retryAfterSeconds } of responses) {
    const body: ErrorResponse = {
      errors: [{ code, message }],
      ...(retryAfterSeconds !== undefined && { retryAfterSeconds }),
    };
    api.addGatewayResponse(`GatewayResponse${type.responseType}`, {
      type,
      ...(statusCode !== undefined && { statusCode: String(statusCode) }),
      // Header values are mapping expressions: literals need single quotes.
      responseHeaders: {
        ...extraHeaders,
        'Cache-Control': "'no-store'",
        ...(retryAfterSeconds !== undefined && { 'Retry-After': `'${retryAfterSeconds}'` }),
      },
      templates: { 'application/json': JSON.stringify(body) },
    });
  }
}

/**
 * Environment and least-privilege IAM for `initReadModel` (Listings and MCP Lambda): the table
 * names, SSM parameter names, config bucket and — with OpenSearch — endpoint and index. Grants only
 * the calls the read side makes: `Query` on `Listings/byId`, `ApiKeys/byHash` and
 * `Agencies/byState` (suspended agencies), `GetItem` on `Listings`, `UpdateItem` on
 * `RateLimitCounters`, the config reads of {@link grantConfigRead} and — with OpenSearch —
 * `aoss:APIAccessAll` on the collection.
 */
export function grantReadModel(
  fn: NodejsFunction,
  props: Pick<ApiStackProps, 'tables' | 'config' | 'openSearch'>,
): void {
  const { listings, apiKeys, rateLimitCounters, agencies } = props.tables;
  fn.addEnvironment(READ_MODEL_ENV.listingsTable, listings.tableName);
  fn.addEnvironment(READ_MODEL_ENV.apiKeysTable, apiKeys.tableName);
  fn.addEnvironment(READ_MODEL_ENV.rateLimitCountersTable, rateLimitCounters.tableName);
  fn.addEnvironment(READ_MODEL_ENV.agenciesTable, agencies.tableName);
  if (props.openSearch !== undefined) {
    // AWS_REGION is set by the Lambda runtime. The data access policy is added by the ApiStack.
    fn.addEnvironment(READ_MODEL_ENV.openSearchEndpoint, props.openSearch.endpoint);
    fn.addEnvironment(READ_MODEL_ENV.openSearchIndex, props.openSearch.index);
    grantCollectionApiAccess(fn, props.openSearch.collectionArn);
  }

  const index = (table: ITableV2, name: string) => `${table.tableArn}/index/${name}`;
  fn.addToRolePolicy(
    new PolicyStatement({
      actions: ['dynamodb:Query'],
      resources: [
        index(listings, LISTINGS_BY_ID_INDEX),
        index(apiKeys, API_KEYS_BY_HASH_INDEX),
        index(agencies, AGENCIES_BY_STATE_INDEX),
      ],
    }),
  );
  fn.addToRolePolicy(
    new PolicyStatement({ actions: ['dynamodb:GetItem'], resources: [listings.tableArn] }),
  );
  fn.addToRolePolicy(
    new PolicyStatement({
      actions: ['dynamodb:UpdateItem'],
      resources: [rateLimitCounters.tableArn],
    }),
  );
  grantConfigRead(fn, props.config);
}

/**
 * Passes the config bucket and the SSM parameter names as environment variables and grants
 * exactly what `loadConfig`/`SsmAccessConfigSource` call: `ssm:GetParameters` on these parameters,
 * `s3:GetObject` on the read model's config files and `s3:ListBucket`, without which S3 answers a
 * missing file with AccessDenied instead of NoSuchKey (needed to report CONFIG_MISSING, Req 9.4,
 * and to treat a missing `tour-providers.json` as empty).
 */
export function grantConfigRead(
  fn: NodejsFunction,
  config: RuntimeConfig,
  files: readonly string[] = Object.values(READ_MODEL_CONFIG_FILES),
): void {
  const stack = Stack.of(fn);
  fn.addEnvironment(CONFIG_BUCKET_ENV, config.configBucket.bucketName);

  const parameterArns: string[] = [];
  for (const [key, name] of Object.entries(RUNTIME_SSM_VALUES) as [SsmParameterKey, string][]) {
    const parameterName = config.parameterNames[key];
    fn.addEnvironment(name + SSM_PARAMETER_SUFFIX, parameterName);
    parameterArns.push(ssmParameterArn(stack, parameterName));
  }

  fn.addToRolePolicy(
    new PolicyStatement({ actions: ['ssm:GetParameters'], resources: parameterArns }),
  );
  fn.addToRolePolicy(
    new PolicyStatement({
      actions: ['s3:GetObject'],
      resources: files.map((key) => config.configBucket.arnForObjects(key)),
    }),
  );
  fn.addToRolePolicy(
    new PolicyStatement({
      actions: ['s3:ListBucket'],
      resources: [config.configBucket.bucketArn],
    }),
  );
}

/**
 * CORS allowlist of the listings Lambda (see `loadCorsPolicy`): the context origins directly, the
 * frontend origin by SSM parameter name, with `ssm:GetParameters` on exactly that parameter.
 */
export function grantCorsConfig(fn: NodejsFunction, cors: ApiCorsProps): void {
  if (cors.allowedOrigins.length > 0) {
    fn.addEnvironment(CORS_ENV.allowedOrigins, cors.allowedOrigins.join(','));
  }
  fn.addEnvironment(
    CORS_CONFIG_VALUES.frontendOrigin + SSM_PARAMETER_SUFFIX,
    cors.frontendOriginParameter,
  );
  fn.addToRolePolicy(
    new PolicyStatement({
      actions: ['ssm:GetParameters'],
      resources: [ssmParameterArn(Stack.of(fn), cors.frontendOriginParameter)],
    }),
  );
}

/**
 * ARN of an SSM parameter in `stack`'s account and region. Built from the plain name instead of
 * `parameterArn`: no cross-stack reference needed.
 */
export function ssmParameterArn(stack: Stack, parameterName: string): string {
  return stack.formatArn({
    service: 'ssm',
    resource: 'parameter',
    resourceName: parameterName.replace(/^\//, ''),
    arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
  });
}
