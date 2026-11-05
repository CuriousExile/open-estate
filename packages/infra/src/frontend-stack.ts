import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import {
  Annotations,
  CfnOutput,
  Duration,
  Fn,
  RemovalPolicy,
  Stack,
  Token,
  type StackProps,
} from 'aws-cdk-lib';
import {
  AllowedMethods,
  CachePolicy,
  CacheCookieBehavior,
  CacheHeaderBehavior,
  CacheQueryStringBehavior,
  Distribution,
  Function as CloudFrontFunction,
  FunctionCode,
  FunctionEventType,
  FunctionRuntime,
  HeadersFrameOption,
  HeadersReferrerPolicy,
  HttpVersion,
  PriceClass,
  ResponseHeadersPolicy,
  ViewerProtocolPolicy,
} from 'aws-cdk-lib/aws-cloudfront';
import { S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { BlockPublicAccess, Bucket, BucketEncryption, ObjectOwnership } from 'aws-cdk-lib/aws-s3';
import {
  BucketDeployment,
  CacheControl,
  Source,
  type ISource,
} from 'aws-cdk-lib/aws-s3-deployment';
import { ParameterTier, StringParameter } from 'aws-cdk-lib/aws-ssm';
import { I18nConfig, READ_MODEL_CONFIG_FILES } from '@open-estate/core';
import { tourHostIndex, TourProvidersConfig } from '@open-estate/shared';
import type { Construct } from 'constructs';
import type { ConfigFile } from './config-files';

/**
 * Files the SPA loads at runtime (frontend `STARTUP_URLS`, `translationUrl`). They are served with
 * `no-cache`, so edits take effect on the next load without a rebuild (Req 8.2, 13.3).
 */
export const FRONTEND_RUNTIME_FILES = {
  index: 'index.html',
  themeConfig: 'theme-config.json',
  i18nConfig: READ_MODEL_CONFIG_FILES.i18n,
  runtimeConfig: 'runtime-config.json',
  translationsDir: 'i18n',
} as const;

/** Content-hashed build artifacts (`outputHashing: all`) never change under the same name. */
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
export const NO_CACHE_CONTROL = 'no-cache';

/** CloudFront limit for the `Content-Security-Policy` value of a response headers policy. */
export const CSP_MAX_LENGTH = 1783;
// Upper bound for the API origin token (`https://<id>.execute-api.<region>.amazonaws.com[.cn]`).
const API_ORIGIN_MAX_LENGTH = 100;
// Upper bound for a tokenized portal source, e.g. the Cognito domain
// (`https://<prefix ≤ 63>.auth.<region>.amazoncognito.com`).
const CONNECT_ORIGIN_MAX_LENGTH = 130;

/** Sources of the runtime files, owned by the frontend package (`packages/frontend/public`). */
export interface FrontendRuntimeSources {
  /** Same file the DataStack mirrors into the config bucket (task 8.7), so both stay in sync. */
  readonly i18nConfigFile: string;
  /** Optional: without it the SPA uses the documented theme defaults (Req 8.3). */
  readonly themeConfigFile: string;
  /** Directory of `{locale}.json` translation files. */
  readonly translationsDir: string;
}

/** Runtime sources next to `i18n-config.json` (the frontend's `public/` layout). */
export function frontendRuntimeSources(i18nConfigFile: string): FrontendRuntimeSources {
  const dir = path.dirname(i18nConfigFile);
  return {
    i18nConfigFile,
    themeConfigFile: path.join(dir, FRONTEND_RUNTIME_FILES.themeConfig),
    translationsDir: path.join(dir, FRONTEND_RUNTIME_FILES.translationsDir),
  };
}

/** Validated runtime files to upload, plus non-fatal findings. */
export interface FrontendRuntimeFiles {
  readonly i18nConfig: ReturnType<typeof I18nConfig.parse>;
  /** Key in the frontend bucket → content. */
  readonly files: readonly ConfigFile[];
  readonly warnings: readonly string[];
}

/** Synth-time failure of the frontend runtime files, e.g. a broken default-locale file (Req 13.9). */
export class FrontendConfigError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Invalid frontend configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'FrontendConfigError';
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Problem of a translation file in the frontend's format (`TranslationSchema`: flat map of keys to
 * texts), or `undefined` if it is valid. Replicated because the Angular package is not a project
 * reference of infra; keep both in sync.
 */
function translationProblem(content: string): string | undefined {
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch (error) {
    return `invalid JSON (${errorText(error)})`;
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return 'expected an object of translation keys to texts';
  }
  const nonString = Object.entries(json).find(([, value]) => typeof value !== 'string');
  return nonString === undefined ? undefined : `value of "${nonString[0]}" is not a string`;
}

function readText(file: string): { content: string } | { problem: string } {
  try {
    return { content: readFileSync(file, 'utf8') };
  } catch (error) {
    return { problem: `cannot read ${file}: ${errorText(error)}` };
  }
}

/**
 * Loads `i18n-config.json`, the translation files and `theme-config.json` at synth. Fails like the
 * SPA start (Req 13.9) if the i18n config or the default locale's file is missing, unreadable or
 * invalid, naming the locale. Broken files of other enabled locales are only warned about: the
 * SPA hides those locales (Req 13.12). Every `*.json` of the translations directory is uploaded,
 * so a new locale only needs its file and an entry in `i18n-config.json` (Req 13.3).
 */
export function loadFrontendRuntimeFiles(sources: FrontendRuntimeSources): FrontendRuntimeFiles {
  const problems: string[] = [];
  const warnings: string[] = [];
  const files: ConfigFile[] = [];
  const i18nKey = FRONTEND_RUNTIME_FILES.i18nConfig;

  const i18nRead = readText(sources.i18nConfigFile);
  if ('problem' in i18nRead) throw new FrontendConfigError([`${i18nKey}: ${i18nRead.problem}`]);
  let i18nJson: unknown;
  try {
    i18nJson = JSON.parse(i18nRead.content);
  } catch (error) {
    throw new FrontendConfigError([`${i18nKey}: invalid JSON (${errorText(error)})`]);
  }
  // Same rules as the frontend's I18nConfigSchema.
  const parsed = I18nConfig.safeParse(i18nJson);
  if (!parsed.success) {
    throw new FrontendConfigError(
      parsed.error.issues.map(
        (issue) => `${i18nKey}: ${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`,
      ),
    );
  }
  const i18nConfig = parsed.data;
  files.push({ key: i18nKey, content: i18nRead.content });

  let translationFiles: string[] = [];
  try {
    translationFiles = readdirSync(sources.translationsDir)
      .filter((name) => name.endsWith('.json'))
      .sort();
  } catch (error) {
    warnings.push(`cannot read ${sources.translationsDir}: ${errorText(error)}`);
  }
  const translations = new Map<string, string>();
  for (const name of translationFiles) {
    const read = readText(path.join(sources.translationsDir, name));
    if ('problem' in read) continue; // reported below if the locale is enabled
    translations.set(name, read.content);
    files.push({ key: `${FRONTEND_RUNTIME_FILES.translationsDir}/${name}`, content: read.content });
  }

  for (const { locale } of i18nConfig.enabled) {
    const name = `${locale}.json`;
    const content = translations.get(name);
    const problem =
      content === undefined
        ? `missing ${path.join(sources.translationsDir, name)}`
        : translationProblem(content);
    if (problem === undefined) continue;
    if (locale === i18nConfig.defaultLocale) {
      problems.push(`translation file of the default locale "${locale}": ${problem}`);
    } else {
      warnings.push(`translation file of enabled locale "${locale}": ${problem} (locale hidden)`);
    }
  }
  if (problems.length > 0) throw new FrontendConfigError(problems);

  if (existsSync(sources.themeConfigFile)) {
    const read = readText(sources.themeConfigFile);
    if ('content' in read) {
      files.push({ key: FRONTEND_RUNTIME_FILES.themeConfig, content: read.content });
    } else {
      warnings.push(`${FRONTEND_RUNTIME_FILES.themeConfig}: ${read.problem}`);
    }
  } else {
    warnings.push(`${FRONTEND_RUNTIME_FILES.themeConfig}: not found, theme defaults apply`);
  }
  return { i18nConfig, files, warnings };
}

/**
 * CSP sources (`'sha256-<base64>'`) of every inline `<script>` (without `src`) of the built
 * `index.html`, hashed exactly as the browser does (UTF-8 of the element's text). Computed from the
 * file that is uploaded, so the hash always matches the deployed script.
 */
export function inlineScriptHashes(html: string): string[] {
  return [...html.matchAll(/<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi)]
    .map(([, body]) => body ?? '')
    .filter((body) => body.trim() !== '')
    .map((body) => `'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`);
}

/** Tour allowlist from the validated config-bucket files; missing file = no provider (default-deny). */
export function tourProvidersFromConfigFiles(files: readonly ConfigFile[]): TourProvidersConfig {
  const file = files.find(({ key }) => key === READ_MODEL_CONFIG_FILES.tourProviders);
  return file === undefined
    ? { providers: [] }
    : TourProvidersConfig.parse(JSON.parse(file.content));
}

/**
 * Content-Security-Policy of the SPA (design: "Sichere Tour-Einbettung"):
 * - `frame-src` exactly the `https://` hosts of the tour allowlist, `'none'` if empty (Req 16.6, 16.8);
 * - `img-src https:` for listing media of any https host (Req 16.1);
 * - `connect-src` adds the Search_API origin, which differs from the SPA's, and the
 *   {@link FrontendStackProps.portalConnectOrigins} of the Agentur_Portal (Management_API, Cognito);
 * - `style-src 'unsafe-inline'`: Angular injects component styles as `<style>` elements at runtime,
 *   and a static S3 origin cannot issue per-response nonces. Scripts stay `'self'` plus the
 *   hashes of the inline scripts of `index.html` (the light/dark theme script that must run before
 *   the first paint, see {@link inlineScriptHashes}); therefore the production build disables
 *   critical-CSS inlining (`angular.json` `inlineCritical: false`), whose inline loader script
 *   would be blocked.
 */
export function contentSecurityPolicy(options: {
  tourProviders: TourProvidersConfig;
  apiOrigin: string;
  /** Further `connect-src` sources (origins or host wildcards); tokens allowed. */
  connectOrigins?: readonly string[];
  /** `'sha256-…'` sources of the inline scripts of `index.html` ({@link inlineScriptHashes}). */
  scriptHashes?: readonly string[];
}): string {
  const tourHosts = [...tourHostIndex(options.tourProviders).keys()]
    .sort()
    .map((host) => `https://${host}`);
  const connectOrigins = options.connectOrigins ?? [];
  const directives: [string, string[]][] = [
    ['default-src', ["'self'"]],
    ['script-src', ["'self'", ...(options.scriptHashes ?? [])]],
    ['style-src', ["'self'", "'unsafe-inline'"]],
    ['img-src', ["'self'", 'https:']],
    ['font-src', ["'self'"]],
    ['connect-src', ["'self'", options.apiOrigin, ...connectOrigins]],
    ['frame-src', tourHosts.length > 0 ? tourHosts : ["'none'"]],
    ['object-src', ["'none'"]],
    ['base-uri', ["'self'"]],
    ['form-action', ["'self'"]],
    ['frame-ancestors', ["'none'"]],
  ];
  const csp = directives.map(([name, values]) => `${name} ${values.join(' ')}`).join('; ');
  // Unresolved tokens count with their upper bound instead of their placeholder length.
  const estimate = (value: string, max: number) =>
    Token.isUnresolved(value) ? max - value.length : 0;
  const length =
    csp.length +
    estimate(options.apiOrigin, API_ORIGIN_MAX_LENGTH) +
    connectOrigins.reduce((sum, origin) => sum + estimate(origin, CONNECT_ORIGIN_MAX_LENGTH), 0);
  if (length > CSP_MAX_LENGTH) {
    throw new FrontendConfigError([
      `Content-Security-Policy would be ~${length} characters (CloudFront limit ${CSP_MAX_LENGTH}); reduce the tour provider host names`,
    ]);
  }
  return csp;
}

/** Origin (`https://host`) of an absolute URL; works for literal URLs and CloudFormation tokens. */
export function urlOrigin(url: string): string {
  return Fn.join('', ['https://', Fn.select(2, Fn.split('/', url))]);
}

/**
 * Viewer-request function for SPA routing: paths whose last segment has no file extension
 * (client routes such as `/listings/abc`) are served `/index.html`. Files keep their real status,
 * so a missing `/i18n/xx.json` stays an error the SPA detects (Req 13.12) instead of a 200 HTML page,
 * which a 403/404 → `index.html` error response would produce.
 */
export const SPA_ROUTING_FUNCTION_CODE = `function handler(event) {
  var request = event.request;
  var last = request.uri.substring(request.uri.lastIndexOf('/') + 1);
  if (last.indexOf('.') === -1) {
    request.uri = '/index.html';
  }
  return request;
}`;

export interface FrontendStackProps extends StackProps {
  /** Built SPA (`packages/frontend/dist/browser`); must contain `index.html`. */
  readonly assetDir: string;
  readonly runtimeSources: FrontendRuntimeSources;
  /** Base URL of the Search_API stage, written to `runtime-config.json` at deploy time. */
  readonly apiUrl: string;
  /** Validated tour allowlist (same source as the config bucket) for the CSP `frame-src`. */
  readonly tourProviders: TourProvidersConfig;
  /**
   * SSM parameter this stack creates with the SPA origin (`https://<distribution domain>`); the
   * Search_API reads it at init for CORS (see `frontendOriginParameterName`).
   */
  readonly frontendOriginParameter: string;
  readonly removalPolicy: RemovalPolicy;
  /** @default PriceClass.PRICE_CLASS_100 */
  readonly priceClass?: PriceClass;
  /**
   * `connect-src` sources of the Agentur_Portal: Management_API and Cognito (see
   * `portalConnectOrigins` of the ManagementStack). They must not reference later stacks — the
   * Identity- and ManagementStack deploy after this one.
   */
  readonly portalConnectOrigins?: readonly string[];
  /**
   * `false`: `runtime-config.json` is written by a later stack (the ManagementStack adds the
   * `portal` block, which needs the Identity and Management outputs). Default `true`: this stack
   * writes `{apiBaseUrl}`.
   */
  readonly writeRuntimeConfig?: boolean;
}

/**
 * Hosting of the SPA: private S3 bucket behind CloudFront (OAC), HTTPS only, HTTP/2 and 3, SPA
 * routing via CloudFront Function and a response headers policy with CSP and security headers.
 * Hashed build artifacts are cached for a year; `index.html` and the runtime files
 * ({@link FRONTEND_RUNTIME_FILES}) are `no-cache`, so branding, locales and translations change
 * without a rebuild (Req 8.2, 13.3). `runtime-config.json` is generated with the API URL (or, with
 * `writeRuntimeConfig: false`, by the ManagementStack including the portal block); the
 * `public/` copy in the build output is only for local development.
 */
export class FrontendStack extends Stack {
  readonly bucket: Bucket;
  readonly distribution: Distribution;
  readonly contentSecurityPolicy: string;
  /** `https://<distribution domain>`; token, resolved at deploy time. */
  readonly origin: string;

  constructor(scope: Construct, id: string, props: FrontendStackProps) {
    super(scope, id, props);
    const indexFile = path.join(props.assetDir, FRONTEND_RUNTIME_FILES.index);
    if (!existsSync(indexFile) || !statSync(props.assetDir).isDirectory()) {
      throw new FrontendConfigError([
        `frontend build output not found: ${indexFile} (run \`npm run build\` first or pass -c frontendAssetDir=<dir>)`,
      ]);
    }
    const runtime = loadFrontendRuntimeFiles(props.runtimeSources);
    for (const warning of runtime.warnings) {
      Annotations.of(this).addWarningV2('open-estate:frontend-config', warning);
    }
    const retain = props.removalPolicy === RemovalPolicy.RETAIN;

    this.bucket = new Bucket(this, 'SiteBucket', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      objectOwnership: ObjectOwnership.BUCKET_OWNER_ENFORCED,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: props.removalPolicy,
      autoDeleteObjects: !retain,
    });

    // Honours the origin's Cache-Control (min TTL 0: `no-cache` is revalidated on every request).
    const cachePolicy = new CachePolicy(this, 'CachePolicy', {
      comment: 'Open Estate SPA: honours origin Cache-Control',
      minTtl: Duration.seconds(0),
      defaultTtl: Duration.days(1),
      maxTtl: Duration.days(365),
      headerBehavior: CacheHeaderBehavior.none(),
      queryStringBehavior: CacheQueryStringBehavior.none(),
      cookieBehavior: CacheCookieBehavior.none(),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });

    this.contentSecurityPolicy = contentSecurityPolicy({
      tourProviders: props.tourProviders,
      apiOrigin: urlOrigin(props.apiUrl),
      connectOrigins: props.portalConnectOrigins ?? [],
      scriptHashes: inlineScriptHashes(readFileSync(indexFile, 'utf8')),
    });
    const responseHeadersPolicy = new ResponseHeadersPolicy(this, 'SecurityHeaders', {
      comment: 'Open Estate SPA: CSP from the tour allowlist and security headers',
      securityHeadersBehavior: {
        contentSecurityPolicy: {
          contentSecurityPolicy: this.contentSecurityPolicy,
          override: true,
        },
        strictTransportSecurity: {
          accessControlMaxAge: Duration.days(730),
          includeSubdomains: true,
          override: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: HeadersFrameOption.DENY, override: true },
        referrerPolicy: {
          referrerPolicy: HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
      },
      customHeadersBehavior: {
        customHeaders: [
          // Features the SPA never uses; fullscreen and motion sensors stay delegable to tours.
          {
            header: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
            override: true,
          },
        ],
      },
    });

    this.distribution = new Distribution(this, 'Distribution', {
      comment: `${id} SPA`,
      defaultRootObject: FRONTEND_RUNTIME_FILES.index,
      httpVersion: HttpVersion.HTTP2_AND_3,
      // No `minimumProtocolVersion`: with the default *.cloudfront.net certificate the policy is
      // fixed at TLSv1 (modern clients still negotiate TLS 1.2/1.3). Enforcing TLS 1.2+ needs a
      // custom domain and ACM certificate (`TLS_V1_2_2021`).
      priceClass: props.priceClass ?? PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(this.bucket),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: AllowedMethods.ALLOW_GET_HEAD,
        compress: true,
        cachePolicy,
        responseHeadersPolicy,
        functionAssociations: [
          {
            eventType: FunctionEventType.VIEWER_REQUEST,
            function: new CloudFrontFunction(this, 'SpaRouting', {
              comment: 'Serves index.html for client-side routes (paths without extension)',
              runtime: FunctionRuntime.JS_2_0,
              code: FunctionCode.fromInline(SPA_ROUTING_FUNCTION_CODE),
            }),
          },
        ],
      },
    });

    // CORS allowlist of the Search_API. Read by name at its init, so no cross-stack reference.
    this.origin = `https://${this.distribution.distributionDomainName}`;
    new StringParameter(this, 'FrontendOriginParameter', {
      parameterName: props.frontendOriginParameter,
      description: 'Origin of the SPA, allowed by the Search_API CORS policy',
      stringValue: this.origin,
      tier: ParameterTier.STANDARD,
    });

    const noCacheKeys = [
      FRONTEND_RUNTIME_FILES.index,
      FRONTEND_RUNTIME_FILES.themeConfig,
      FRONTEND_RUNTIME_FILES.i18nConfig,
      FRONTEND_RUNTIME_FILES.runtimeConfig,
      `${FRONTEND_RUNTIME_FILES.translationsDir}/*`,
    ];
    // Hashed artifacts. The no-cache files are excluded from upload (the build output holds stale
    // copies of `public/`) and, via `exclude`, from pruning, so this deployment never deletes them.
    const assets = new BucketDeployment(this, 'AppAssets', {
      destinationBucket: this.bucket,
      sources: [
        Source.asset(props.assetDir, {
          exclude: [
            FRONTEND_RUNTIME_FILES.index,
            FRONTEND_RUNTIME_FILES.themeConfig,
            FRONTEND_RUNTIME_FILES.i18nConfig,
            FRONTEND_RUNTIME_FILES.runtimeConfig,
            FRONTEND_RUNTIME_FILES.translationsDir,
          ],
        }),
      ],
      exclude: noCacheKeys,
      cacheControl: [CacheControl.fromString(IMMUTABLE_CACHE_CONTROL)],
      prune: true,
      retainOnDelete: retain,
    });

    // `prune: false`: only (over)writes these keys. A removed translation file stays until deleted
    // manually; the SPA only offers locales enabled in `i18n-config.json`.
    const runtimeFiles: ISource[] = [
      Source.data(FRONTEND_RUNTIME_FILES.index, readFileSync(indexFile, 'utf8')),
      ...runtime.files.map(({ key, content }) => Source.data(key, content)),
      ...(props.writeRuntimeConfig === false
        ? []
        : [Source.jsonData(FRONTEND_RUNTIME_FILES.runtimeConfig, { apiBaseUrl: props.apiUrl })]),
    ];
    const noCache = new BucketDeployment(this, 'RuntimeFiles', {
      destinationBucket: this.bucket,
      sources: runtimeFiles,
      cacheControl: [CacheControl.fromString(NO_CACHE_CONTROL)],
      prune: false,
      retainOnDelete: retain,
      distribution: this.distribution,
      distributionPaths: ['/', ...noCacheKeys.map((key) => `/${key}`)],
    });
    // index.html last: it must not reference artifacts that are not uploaded yet.
    noCache.node.addDependency(assets);

    new CfnOutput(this, 'DistributionDomainName', {
      description: 'CloudFront domain of the frontend',
      value: this.distribution.distributionDomainName,
    });
    new CfnOutput(this, 'FrontendUrl', {
      description: 'URL of the frontend',
      value: this.origin,
    });
  }
}
