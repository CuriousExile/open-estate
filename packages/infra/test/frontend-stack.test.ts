import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { App, Lazy, RemovalPolicy, Stage, type Stack } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { READ_MODEL_CONFIG_FILES } from '@open-estate/core';
import type { TourProvidersConfig } from '@open-estate/shared';
import { DEFAULT_CONFIG_DIR, DEFAULT_I18N_CONFIG_FILE } from '../src/config';
import { loadConfigDirectory } from '../src/config-files';
import {
  contentSecurityPolicy,
  FrontendConfigError,
  FrontendStack,
  frontendRuntimeSources,
  type FrontendRuntimeSources,
  IMMUTABLE_CACHE_CONTROL,
  inlineScriptHashes,
  loadFrontendRuntimeFiles,
  NO_CACHE_CONTROL,
  SPA_ROUTING_FUNCTION_CODE,
  tourProvidersFromConfigFiles,
} from '../src/frontend-stack';

const CDK_CONTEXT = (
  JSON.parse(readFileSync(path.join(__dirname, '../cdk.json'), 'utf8')) as {
    context: Record<string, unknown>;
  }
).context;

const API_URL = 'https://abc123.execute-api.eu-central-1.amazonaws.com/dev/';
const API_ORIGIN = 'https://abc123.execute-api.eu-central-1.amazonaws.com';
const FRONTEND_SRC = path.join(__dirname, '../../frontend/src');
const MATTERPORT: TourProvidersConfig = {
  providers: [{ code: 'matterport', hostnames: ['My.Matterport.com', 'mpembed.com'] }],
};

let dir: string;
let assetDir: string;
let publicDir: string;

function write(file: string, content: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
}

beforeEach(() => {
  // Fixture instead of the real build output, so the tests need no `npm run build`.
  dir = mkdtempSync(path.join(tmpdir(), 'open-estate-frontend-'));
  assetDir = path.join(dir, 'dist');
  publicDir = path.join(dir, 'public');
  write(path.join(assetDir, 'index.html'), '<!doctype html><script src="main-ABC.js"></script>');
  write(path.join(assetDir, 'main-ABC.js'), 'console.log(1)');
  write(path.join(publicDir, 'i18n-config.json'), {
    defaultLocale: 'en',
    enabled: [
      { locale: 'en', label: 'English' },
      { locale: 'de', label: 'Deutsch' },
    ],
  });
  write(path.join(publicDir, 'theme-config.json'), { colors: { primary: '#000000' } });
  write(path.join(publicDir, 'i18n/en.json'), { 'app.title': 'Open Estate' });
  write(path.join(publicDir, 'i18n/de.json'), { 'app.title': 'Open Estate' });
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function synth(
  tourProviders: TourProvidersConfig = { providers: [] },
  options: { removalPolicy?: RemovalPolicy; runtimeSources?: FrontendRuntimeSources } = {},
) {
  // Assembly inside the fixture dir: removed with it, and staged assets can be inspected.
  const app = new App({ context: CDK_CONTEXT, outdir: path.join(dir, 'cdk.out') });
  const stack = new FrontendStack(app, 'OpenEstate-test-Frontend', {
    assetDir,
    runtimeSources:
      options.runtimeSources ?? frontendRuntimeSources(path.join(publicDir, 'i18n-config.json')),
    // A token like the cross-stack `api.url`, resolved at deploy time.
    apiUrl: Lazy.string({ produce: () => API_URL }),
    tourProviders,
    frontendOriginParameter: '/open-estate/test/frontend-origin',
    removalPolicy: options.removalPolicy ?? RemovalPolicy.DESTROY,
  });
  return { stack, template: Template.fromStack(stack) };
}

/** Evaluates the intrinsics the CSP uses (Join/Select/Split over literals) to the final string. */
function evaluate(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const [fn, args] = Object.entries(value)[0] as [string, unknown[]];
  const [first, second] = args.map(evaluate) as [unknown, unknown];
  if (fn === 'Fn::Join') return (second as string[]).map(evaluate).join(first as string);
  if (fn === 'Fn::Select') return (second as string[])[Number(first)];
  if (fn === 'Fn::Split') return (second as string).split(first as string);
  throw new Error(`unexpected intrinsic ${fn}`);
}

function cspOf(template: Template): string {
  const policies = Object.values(template.findResources('AWS::CloudFront::ResponseHeadersPolicy'));
  const config = (
    policies[0] as {
      Properties: {
        ResponseHeadersPolicyConfig: {
          SecurityHeadersConfig: { ContentSecurityPolicy: { ContentSecurityPolicy: unknown } };
        };
      };
    }
  ).Properties.ResponseHeadersPolicyConfig;
  return evaluate(
    config.SecurityHeadersConfig.ContentSecurityPolicy.ContentSecurityPolicy,
  ) as string;
}

/** Directive name → source list; fails on a repeated directive (browsers ignore all but the first). */
function cspDirectives(csp: string): Record<string, string[]> {
  const entries = csp.split('; ').map((directive) => {
    const [name = '', ...sources] = directive.split(' ');
    return [name, sources] as const;
  });
  expect(new Set(entries.map(([name]) => name)).size).toBe(entries.length);
  return Object.fromEntries(entries);
}

type Resource = {
  Properties: Record<string, unknown>;
  DependsOn?: string[];
  DeletionPolicy?: string;
};

/** The single resource of `type` whose logical id starts with `prefix` (fails on 0 or 2+). */
function resource(template: Template, type: string, prefix = ''): [string, Resource] {
  const matches = Object.entries(template.findResources(type)).filter(([id]) =>
    id.startsWith(prefix),
  );
  expect(matches.map(([id]) => id)).toHaveLength(1);
  const [id, value] = matches[0] ?? [];
  return [id as string, value as Resource];
}

const deployment = (template: Template, id: 'AppAssets' | 'RuntimeFiles') =>
  resource(template, 'Custom::CDKBucketDeployment', `${id}CustomResource`);

/** Relative paths of all files below `root`, sorted, with `/` separators. */
function filesBelow(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)))
    .map((file) => file.split(path.sep).join('/'))
    .sort();
}

/**
 * Bucket key → content of every file a deployment uploads, read from the staged assets of the cloud
 * assembly (`asset.<hash>` for source object key `<hash>.zip`).
 */
function uploadedFiles(stack: Stack, props: Record<string, unknown>): Map<string, string> {
  const assemblyDir = Stage.of(stack)?.synth().directory ?? '';
  const files = new Map<string, string>();
  for (const objectKey of props.SourceObjectKeys as string[]) {
    const assetDir = path.join(assemblyDir, `asset.${objectKey.replace(/\.zip$/, '')}`);
    for (const key of filesBelow(assetDir)) {
      expect(files.has(key)).toBe(false); // two sources writing one key: last one wins silently
      files.set(key, readFileSync(path.join(assetDir, key), 'utf8'));
    }
  }
  return files;
}

const RUNTIME_KEYS = [
  'index.html',
  'theme-config.json',
  'i18n-config.json',
  'runtime-config.json',
  'i18n/*',
];

describe('FrontendStack', () => {
  it('keeps the bucket private and serves it via CloudFront OAC over HTTPS, HTTP/2+3', () => {
    const { template } = synth();
    template.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      BucketEncryption: Match.objectLike({}),
    });
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Deny',
            Condition: { Bool: { 'aws:SecureTransport': 'false' } },
          }),
        ]),
      },
    });
    template.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultRootObject: 'index.html',
        HttpVersion: 'http2and3',
        PriceClass: 'PriceClass_100',
        DefaultCacheBehavior: Match.objectLike({
          ViewerProtocolPolicy: 'redirect-to-https',
          FunctionAssociations: [Match.objectLike({ EventType: 'viewer-request' })],
        }),
      }),
    });
    // SPA routing by function, not by error responses (would turn a missing i18n file into 200).
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({ CustomErrorResponses: Match.absent() }),
    });
    template.hasResourceProperties('AWS::CloudFront::CachePolicy', {
      CachePolicyConfig: Match.objectLike({ MinTTL: 0 }),
    });
  });

  it('uploads hashed assets immutable and the runtime files no-cache with invalidation', () => {
    const { template } = synth();
    template.hasResourceProperties('Custom::CDKBucketDeployment', {
      SystemMetadata: { 'cache-control': IMMUTABLE_CACHE_CONTROL },
      Prune: true,
      Exclude: Match.arrayWith(['index.html', 'i18n-config.json', 'i18n/*']),
    });
    template.hasResourceProperties('Custom::CDKBucketDeployment', {
      SystemMetadata: { 'cache-control': NO_CACHE_CONTROL },
      Prune: false,
      DistributionPaths: Match.arrayWith([
        '/index.html',
        '/theme-config.json',
        '/i18n-config.json',
        '/runtime-config.json',
        '/i18n/*',
      ]),
    });
  });

  it('writes runtime-config.json with the API URL at deploy time', () => {
    const { template } = synth();
    template.hasResourceProperties('Custom::CDKBucketDeployment', {
      SourceMarkers: Match.arrayWith([
        Match.objectLike({ '<<marker:0xbaba:0>>': JSON.stringify(API_URL) }),
      ]),
    });
  });

  it('builds the CSP from the tour allowlist and the API origin', () => {
    const csp = cspOf(synth(MATTERPORT).template);
    expect(csp).toContain('frame-src https://mpembed.com https://my.matterport.com;');
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("img-src 'self' https:;");
    expect(csp).toContain(`connect-src 'self' ${API_ORIGIN};`);
    expect(csp).toContain("script-src 'self';");
  });

  it('denies all frames when no tour provider is allowed', () => {
    expect(cspOf(synth().template)).toContain("frame-src 'none'");
  });

  it('allows the inline theme script of the built index.html by its hash', () => {
    const html = '<!doctype html><script>applyTheme();</script><script src="main-ABC.js"></script>';
    write(path.join(assetDir, 'index.html'), html);
    const [hash] = inlineScriptHashes(html);
    expect(cspOf(synth().template)).toContain(`script-src 'self' ${hash};`);
  });

  it('lets listing images load from any https host, but not over http or as data: URLs', () => {
    // Listing media are hosted by agencies and connectors (Req 16.1); the image placeholder is
    // inline SVG markup, so no `data:` source is needed.
    const imgSrc = /img-src ([^;]*)/.exec(cspOf(synth().template))?.[1]?.split(' ');
    expect(imgSrc).toEqual(["'self'", 'https:']);
  });

  it('fails synth with a hint when the build output is missing', () => {
    rmSync(assetDir, { recursive: true });
    expect(() => synth()).toThrow(/npm run build/);
  });

  it('warns about an enabled non-default locale without translation file', () => {
    rmSync(path.join(publicDir, 'i18n/de.json'));
    const { stack } = synth();
    Annotations.fromStack(stack).hasWarning('*', Match.stringLikeRegexp('locale "de"'));
  });
});

describe('FrontendStack cache policy (Req 8.2)', () => {
  it('honours the origin Cache-Control with a minimal cache key', () => {
    const { template } = synth();
    const [, policy] = resource(template, 'AWS::CloudFront::CachePolicy');
    expect(policy.Properties.CachePolicyConfig).toEqual({
      Comment: 'Open Estate SPA: honours origin Cache-Control',
      Name: expect.anything(),
      MinTTL: 0,
      DefaultTTL: 86_400,
      MaxTTL: 31_536_000,
      ParametersInCacheKeyAndForwardedToOrigin: {
        HeadersConfig: { HeaderBehavior: 'none' },
        CookiesConfig: { CookieBehavior: 'none' },
        QueryStringsConfig: { QueryStringBehavior: 'none' },
        EnableAcceptEncodingGzip: true,
        EnableAcceptEncodingBrotli: true,
      },
    });
  });

  it('applies it and the security headers to the only behavior, read-only and compressed', () => {
    const { template } = synth();
    const [cachePolicy] = resource(template, 'AWS::CloudFront::CachePolicy');
    const [headersPolicy] = resource(template, 'AWS::CloudFront::ResponseHeadersPolicy');
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        CacheBehaviors: Match.absent(),
        DefaultCacheBehavior: Match.objectLike({
          CachePolicyId: { Ref: cachePolicy },
          ResponseHeadersPolicyId: { Ref: headersPolicy },
          AllowedMethods: ['GET', 'HEAD'],
          Compress: true,
          // Legacy settings would bypass the cache policy.
          ForwardedValues: Match.absent(),
          OriginRequestPolicyId: Match.absent(),
        }),
      }),
    });
  });
});

describe('FrontendStack response headers (Req 16.6)', () => {
  it('renders every CSP directive exactly', () => {
    expect(cspDirectives(cspOf(synth(MATTERPORT).template))).toEqual({
      'default-src': ["'self'"],
      'script-src': ["'self'"],
      'style-src': ["'self'", "'unsafe-inline'"],
      'img-src': ["'self'", 'https:'],
      'font-src': ["'self'"],
      'connect-src': ["'self'", API_ORIGIN],
      'frame-src': ['https://mpembed.com', 'https://my.matterport.com'],
      'object-src': ["'none'"],
      'base-uri': ["'self'"],
      'form-action': ["'self'"],
      'frame-ancestors': ["'none'"],
    });
  });

  // Only `frame-src` depends on the allowlist; the stack prop is not re-validated, so duplicates
  // the schema would reject must still not produce repeated sources.
  it.each<[string, TourProvidersConfig['providers'], string[]]>([
    ['no provider', [], ["'none'"]],
    ['one host', [{ code: 'kuula', hostnames: ['kuula.co'] }], ['https://kuula.co']],
    [
      'mixed case',
      [{ code: 'matterport', hostnames: ['MY.Matterport.COM', 'MpEmbed.com'] }],
      ['https://mpembed.com', 'https://my.matterport.com'],
    ],
    [
      'unsorted hosts of several providers',
      [
        { code: 'zz', hostnames: ['z.example.com', 'b.example.com'] },
        { code: 'aa', hostnames: ['m.example.com'] },
      ],
      ['https://b.example.com', 'https://m.example.com', 'https://z.example.com'],
    ],
    [
      'case-variant duplicates across providers',
      [
        { code: 'one', hostnames: ['Tour.Example.com', 'a.example.com'] },
        { code: 'two', hostnames: ['tour.example.COM'] },
        { code: 'three', hostnames: ['A.EXAMPLE.COM', 'tour.example.com'] },
      ],
      ['https://a.example.com', 'https://tour.example.com'],
    ],
  ])('frame-src for %s', (_, providers, expected) => {
    const directives = cspDirectives(cspOf(synth({ providers }).template));
    expect(directives['frame-src']).toEqual(expected);
    // Everything else is independent of the allowlist.
    expect(directives['default-src']).toEqual(["'self'"]);
    expect(directives['frame-ancestors']).toEqual(["'none'"]);
  });

  it('overrides origin headers with the CSP and the security headers', () => {
    const { template } = synth();
    const [, policy] = resource(template, 'AWS::CloudFront::ResponseHeadersPolicy');
    const config = policy.Properties.ResponseHeadersPolicyConfig as {
      SecurityHeadersConfig: Record<string, unknown>;
      CustomHeadersConfig: unknown;
      CorsConfig?: unknown;
    };
    expect(config.SecurityHeadersConfig).toEqual({
      ContentSecurityPolicy: { ContentSecurityPolicy: expect.anything(), Override: true },
      StrictTransportSecurity: {
        AccessControlMaxAgeSec: 63_072_000,
        IncludeSubdomains: true,
        Override: true,
      },
      ContentTypeOptions: { Override: true },
      FrameOptions: { FrameOption: 'DENY', Override: true },
      ReferrerPolicy: { ReferrerPolicy: 'strict-origin-when-cross-origin', Override: true },
    });
    expect(config.CustomHeadersConfig).toEqual({
      Items: [
        {
          Header: 'Permissions-Policy',
          Value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
          Override: true,
        },
      ],
    });
    expect(config.CorsConfig).toBeUndefined();
  });
});

describe('FrontendStack bucket deployments (Req 8.2)', () => {
  beforeEach(() => {
    // Like the real build output: hashed artifacts plus stale copies of `public/`.
    write(path.join(assetDir, 'media/font-XYZ.woff2'), 'font');
    write(path.join(assetDir, 'theme-config.json'), { stale: true });
    write(path.join(assetDir, 'i18n-config.json'), { stale: true });
    write(path.join(assetDir, 'runtime-config.json'), { apiBaseUrl: 'http://localhost:3000' });
    write(path.join(assetDir, 'i18n/en.json'), { stale: 'true' });
    // Uploaded although not enabled (a new locale only needs its file); non-JSON is skipped.
    write(path.join(publicDir, 'i18n/fr.json'), { 'app.title': 'Open Estate' });
    write(path.join(publicDir, 'i18n/README.md'), 'not a translation');
  });

  it('uploads only hashed artifacts, immutable, and never prunes the runtime files', () => {
    const { stack, template } = synth();
    const [, assets] = deployment(template, 'AppAssets');
    expect([...uploadedFiles(stack, assets.Properties).keys()]).toEqual([
      'main-ABC.js',
      'media/font-XYZ.woff2',
    ]);
    expect(assets.Properties).toMatchObject({
      Prune: true,
      Exclude: RUNTIME_KEYS,
      SystemMetadata: { 'cache-control': IMMUTABLE_CACHE_CONTROL },
    });
    // Invalidation belongs to the runtime files; hashed names never need it.
    expect(assets.Properties.DistributionId).toBeUndefined();
  });

  it('uploads index.html, configs, every translation and runtime-config.json no-cache', () => {
    const { stack, template } = synth();
    const [, runtime] = deployment(template, 'RuntimeFiles');
    const files = uploadedFiles(stack, runtime.Properties);
    expect([...files.keys()].sort()).toEqual([
      'i18n-config.json',
      'i18n/de.json',
      'i18n/en.json',
      'i18n/fr.json',
      'index.html',
      'runtime-config.json',
      'theme-config.json',
    ]);
    // From the build output resp. `public/`, not the stale build copies.
    expect(files.get('index.html')).toBe(readFileSync(path.join(assetDir, 'index.html'), 'utf8'));
    for (const key of ['theme-config.json', 'i18n-config.json', 'i18n/en.json']) {
      expect(files.get(key)).toBe(readFileSync(path.join(publicDir, key), 'utf8'));
    }
    // The API URL is a deploy-time token: apply the markers like the deployment handler does.
    const objectKeys = runtime.Properties.SourceObjectKeys as string[];
    const markers = runtime.Properties.SourceMarkers as Record<string, string>[];
    const configSource = objectKeys.findIndex((_, i) => Object.keys(markers[i] ?? {}).length > 0);
    const deployed = Object.entries(markers[configSource] ?? {}).reduce(
      (content, [marker, value]) => content.split(marker).join(value),
      files.get('runtime-config.json') ?? '',
    );
    expect(JSON.parse(deployed)).toEqual({ apiBaseUrl: API_URL });

    expect(runtime.Properties).toMatchObject({
      Prune: false,
      SystemMetadata: { 'cache-control': NO_CACHE_CONTROL },
    });
    expect(runtime.Properties.Exclude).toBeUndefined();
  });

  it('invalidates exactly the runtime paths after uploading the hashed artifacts', () => {
    const { template } = synth();
    const [distribution] = resource(template, 'AWS::CloudFront::Distribution');
    const [assetsId] = deployment(template, 'AppAssets');
    const [, runtime] = deployment(template, 'RuntimeFiles');
    expect(runtime.Properties.DistributionId).toEqual({ Ref: distribution });
    expect(runtime.Properties.DistributionPaths).toEqual([
      '/',
      ...RUNTIME_KEYS.map((key) => `/${key}`),
    ]);
    expect(runtime.DependsOn).toContain(assetsId);
  });

  it.each([
    ['dev', RemovalPolicy.DESTROY, false],
    ['prod', RemovalPolicy.RETAIN, true],
  ])('%s: retains objects and bucket only when retaining', (_, removalPolicy, retain) => {
    const { template } = synth(undefined, { removalPolicy });
    for (const id of ['AppAssets', 'RuntimeFiles'] as const) {
      expect(deployment(template, id)[1].Properties.RetainOnDelete).toBe(retain);
    }
    const [, bucket] = resource(template, 'AWS::S3::Bucket');
    expect(bucket.DeletionPolicy).toBe(retain ? 'Retain' : 'Delete');
    template.resourceCountIs('Custom::S3AutoDeleteObjects', retain ? 0 : 1);
  });
});

describe('FrontendStack origin parameter and outputs', () => {
  it('publishes https://<distribution domain> to SSM and as outputs', () => {
    const { template } = synth();
    const [distribution] = resource(template, 'AWS::CloudFront::Distribution');
    const domain = { 'Fn::GetAtt': [distribution, 'DomainName'] };
    const origin = { 'Fn::Join': ['', ['https://', domain]] };
    const [, parameter] = resource(template, 'AWS::SSM::Parameter');
    expect(parameter.Properties).toMatchObject({
      Name: '/open-estate/test/frontend-origin',
      Type: 'String',
      Tier: 'Standard',
      Value: origin,
    });
    expect(template.findOutputs('*')).toEqual({
      DistributionDomainName: { Description: 'CloudFront domain of the frontend', Value: domain },
      FrontendUrl: { Description: 'URL of the frontend', Value: origin },
    });
  });
});

describe('FrontendStack with the repository configuration', () => {
  it('synthesizes the shipped frontend files and tour allowlist without warnings', () => {
    const configFiles = loadConfigDirectory(DEFAULT_CONFIG_DIR, {
      [READ_MODEL_CONFIG_FILES.i18n]: DEFAULT_I18N_CONFIG_FILE,
    });
    const tourProviders = tourProvidersFromConfigFiles(configFiles);
    const { stack, template } = synth(tourProviders, {
      runtimeSources: frontendRuntimeSources(DEFAULT_I18N_CONFIG_FILE),
    });

    const annotations = Annotations.fromStack(stack);
    annotations.hasNoWarning('*', Match.anyValue());
    annotations.hasNoError('*', Match.anyValue());

    const realPublic = path.dirname(DEFAULT_I18N_CONFIG_FILE);
    const translations = readdirSync(path.join(realPublic, 'i18n'))
      .filter((name) => name.endsWith('.json'))
      .map((name) => `i18n/${name}`);
    const [, runtime] = deployment(template, 'RuntimeFiles');
    const files = uploadedFiles(stack, runtime.Properties);
    expect([...files.keys()].sort()).toEqual(
      [
        'i18n-config.json',
        'index.html',
        'runtime-config.json',
        'theme-config.json',
        ...translations,
      ].sort(),
    );
    expect(files.get('i18n-config.json')).toBe(readFileSync(DEFAULT_I18N_CONFIG_FILE, 'utf8'));

    // `frame-src` follows the shipped allowlist, whatever it currently lists.
    const hosts = [
      ...new Set(tourProviders.providers.flatMap((p) => p.hostnames.map((h) => h.toLowerCase()))),
    ]
      .sort()
      .map((host) => `https://${host}`);
    expect(cspDirectives(cspOf(template))['frame-src']).toEqual(
      hosts.length > 0 ? hosts : ["'none'"],
    );
  });
});

describe('loadFrontendRuntimeFiles: default-locale file at synth (Req 13.9)', () => {
  const sources = () => frontendRuntimeSources(path.join(publicDir, 'i18n-config.json'));

  it.each([
    ['missing', undefined, /missing/],
    ['invalid JSON', '{', /invalid JSON/],
    ['not a flat string map', { app: { title: 'x' } }, /"app" is not a string/],
  ])('fails when the file is %s, naming the locale', (_, content, detail) => {
    const file = path.join(publicDir, 'i18n/en.json');
    if (content === undefined) rmSync(file);
    else write(file, content);
    expect(() => loadFrontendRuntimeFiles(sources())).toThrow(FrontendConfigError);
    expect(() => loadFrontendRuntimeFiles(sources())).toThrow(/default locale "en"/);
    expect(() => loadFrontendRuntimeFiles(sources())).toThrow(detail);
  });

  it('fails on an invalid i18n-config.json', () => {
    write(path.join(publicDir, 'i18n-config.json'), { defaultLocale: 'fr', enabled: [] });
    expect(() => loadFrontendRuntimeFiles(sources())).toThrow(/i18n-config\.json/);
  });

  it('accepts the shipped frontend files without warnings', () => {
    const result = loadFrontendRuntimeFiles(frontendRuntimeSources(DEFAULT_I18N_CONFIG_FILE));
    expect(result.warnings).toEqual([]);
    expect(result.files.map(({ key }) => key)).toEqual(
      expect.arrayContaining(['i18n-config.json', 'theme-config.json', 'i18n/en.json']),
    );
  });
});

describe('contentSecurityPolicy', () => {
  it('rejects a policy longer than the CloudFront limit', () => {
    const hostnames = Array.from({ length: 80 }, (_, i) => `tour-${i}.example-provider.com`);
    expect(() =>
      contentSecurityPolicy({
        tourProviders: { providers: [{ code: 'many', hostnames }] },
        apiOrigin: API_ORIGIN,
      }),
    ).toThrow(/CloudFront limit/);
  });

  it('treats a missing tour-providers.json as an empty allowlist', () => {
    expect(tourProvidersFromConfigFiles([])).toEqual({ providers: [] });
  });

  it('allows the inline scripts of index.html by their SHA-256 hash, never script-src unsafe-inline', () => {
    const body = "\n  document.documentElement.setAttribute('data-theme', 'dark');\n";
    const html = `<html><head><script>${body}</script><script src="main.js"></script></head></html>`;
    const hashes = inlineScriptHashes(html);
    const expected = `'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`;
    expect(hashes).toEqual([expected]);
    expect(inlineScriptHashes('<script src="a.js"></script><script> </script>')).toEqual([]);
    const csp = contentSecurityPolicy({
      tourProviders: { providers: [] },
      apiOrigin: API_ORIGIN,
      scriptHashes: hashes,
    });
    expect(csp).toContain(`script-src 'self' ${expected};`);
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
  });

  it('hashes the light/dark theme script of the frontend source index.html', () => {
    const html = readFileSync(path.join(FRONTEND_SRC, 'index.html'), 'utf8');
    expect(inlineScriptHashes(html)).toHaveLength(1);
  });
});

describe('SPA routing function', () => {
  // The inline CloudFront Function source, evaluated as plain JS.
  const handler = new Function(`${SPA_ROUTING_FUNCTION_CODE}; return handler;`)() as (event: {
    request: { uri: string };
  }) => { uri: string };

  it.each([
    ['/', '/index.html'],
    ['/listings/abc', '/index.html'],
    ['/i18n/xx.json', '/i18n/xx.json'],
    ['/main-ABC.js', '/main-ABC.js'],
  ])('maps %s to %s', (uri, expected) => {
    expect(handler({ request: { uri } }).uri).toBe(expected);
  });
});
