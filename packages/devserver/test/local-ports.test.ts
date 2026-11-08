import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import {
  PortalConfigSchema,
  RuntimeConfigSchema,
} from '../../frontend/src/app/startup/config-schemas';
import { DEFAULT_PORTS, DemoClock, loadContentConfig, readNetworkConfig } from '../src/config';
import { DEMO_MEDIA_PREFIX } from '../src/media/demo-media';
import { createDevPlatform } from '../src/platform';
import { RUNTIME_CONFIG_PATH } from '../src/runtime-config';
import { SEED_USERS } from '../src/seed/demo-data';
import { createRequestListener, PREFIX } from '../src/server';

// Configurable ports of the local demo (docs/local-demo.md → Ports): the dev server, the SPA's
// runtime config it serves and the `ng serve` proxy all follow DEV_PORT / DEV_FRONTEND_PORT.

const PROXY_CONFIG = path.resolve(__dirname, '../../frontend/dev/proxy.local.mjs');

describe('readNetworkConfig', () => {
  it('defaults to 4310 for the dev server and 4200 for the SPA', () => {
    expect(DEFAULT_PORTS).toEqual({ api: 4310, frontend: 4200 });
    expect(readNetworkConfig({})).toEqual({
      host: '127.0.0.1',
      port: 4310,
      frontendPort: 4200,
      frontendOrigin: 'http://127.0.0.1:4200',
      publicUrl: 'http://127.0.0.1:4310',
    });
  });

  it('derives the SPA origin from DEV_FRONTEND_PORT', () => {
    expect(readNetworkConfig({ DEV_PORT: ' 5310 ', DEV_FRONTEND_PORT: '5200' })).toMatchObject({
      port: 5310,
      frontendPort: 5200,
      frontendOrigin: 'http://127.0.0.1:5200',
      publicUrl: 'http://127.0.0.1:5310',
    });
  });

  it('keeps an explicit DEV_FRONTEND_ORIGIN (without trailing slash)', () => {
    const network = readNetworkConfig({
      DEV_FRONTEND_PORT: '5200',
      DEV_FRONTEND_ORIGIN: 'http://localhost:8080/',
    });
    expect(network).toMatchObject({ frontendPort: 5200, frontendOrigin: 'http://localhost:8080' });
  });

  it('uses [::1] in the public URL of an IPv6 loopback host', () => {
    expect(readNetworkConfig({ DEV_HOST: '::1', DEV_PORT: '5310' }).publicUrl).toBe(
      'http://[::1]:5310',
    );
  });

  it.each(['0', '65536', '-1', '42x', '0x10', '4310.5'])('rejects the port %j', (value) => {
    expect(() => readNetworkConfig({ DEV_PORT: value })).toThrow(/^DEV_PORT=.*TCP port/);
    expect(() => readNetworkConfig({ DEV_FRONTEND_PORT: value })).toThrow(
      /^DEV_FRONTEND_PORT=.*TCP port/,
    );
  });

  it.each(['nope', 'ftp://127.0.0.1:4200', '127.0.0.1:4200'])(
    'rejects the SPA origin %j',
    (value) => {
      expect(() => readNetworkConfig({ DEV_FRONTEND_ORIGIN: value })).toThrow(
        /DEV_FRONTEND_ORIGIN=.*http\(s\) origin/,
      );
    },
  );
});

describe('runtime-config.json of the SPA', () => {
  const ISSUER = 'http://127.0.0.1:5310/oidc';
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const platform = createDevPlatform({
      config: loadContentConfig(),
      clock: new DemoClock(),
      frontendOrigin: 'http://127.0.0.1:5200',
      issuer: ISSUER,
      clientId: 'local-portal-client',
      directoryUsers: SEED_USERS,
      connectorModules: [],
      logger: { error: () => undefined },
    });
    server = createServer(createRequestListener({ platform, info: () => ({}) }));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('points the portal at the issuer of this server; the SPA accepts it', async () => {
    const response = await fetch(`${base}${RUNTIME_CONFIG_PATH}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(response.headers.get('cache-control')).toBe('no-cache');
    const body: unknown = await response.json();
    expect(body).toEqual({
      apiBaseUrl: '/api',
      portal: {
        issuer: ISSUER,
        cognitoDomainUrl: ISSUER,
        clientId: 'local-portal-client',
        managementApiUrl: '/management',
      },
    });
    const parsed = RuntimeConfigSchema.parse(body);
    expect(PortalConfigSchema.safeParse(parsed.portal).success).toBe(true);
  });

  it('answers HEAD and refuses other methods', async () => {
    const head = await fetch(`${base}${RUNTIME_CONFIG_PATH}`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    const post = await fetch(`${base}${RUNTIME_CONFIG_PATH}`, { method: 'POST' });
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET, HEAD');
  });
});

describe('ng serve proxy (packages/frontend/dev/proxy.local.mjs)', () => {
  /** The proxy table as `ng serve` loads it, with `env` as the environment. */
  function proxyTable(env: Record<string, string>): Record<string, { target: string }> {
    const script = `import(${JSON.stringify(`file://${PROXY_CONFIG}`)}).then((m) => process.stdout.write(JSON.stringify(m.default)))`;
    // Only the given variables: a DEV_HOST / DEV_PORT of the calling shell must not leak in.
    const inherited = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => name !== 'DEV_HOST' && name !== 'DEV_PORT'),
    );
    const out = execFileSync(process.execPath, ['-e', script], {
      env: { ...inherited, ...env },
      encoding: 'utf8',
    });
    return JSON.parse(out) as Record<string, { target: string }>;
  }

  it('forwards every path the SPA loads from the dev server (the browser goes to /oidc directly)', () => {
    const paths = Object.keys(proxyTable({})).sort();
    expect(paths).toEqual(
      [PREFIX.api, PREFIX.management, PREFIX.mcp, DEMO_MEDIA_PREFIX, RUNTIME_CONFIG_PATH].sort(),
    );
  });

  it('targets DEV_HOST and DEV_PORT like the dev server, 127.0.0.1:4310 by default', () => {
    const targets = (env: Record<string, string>) =>
      new Set(Object.values(proxyTable(env)).map((entry) => entry.target));
    expect(targets({})).toEqual(new Set(['http://127.0.0.1:4310']));
    expect(targets({ DEV_PORT: '5310' })).toEqual(new Set(['http://127.0.0.1:5310']));
    expect(targets({ DEV_HOST: '::1', DEV_PORT: '5310' })).toEqual(new Set(['http://[::1]:5310']));
    const network = readNetworkConfig({ DEV_HOST: 'localhost', DEV_PORT: '5311' });
    expect(targets({ DEV_HOST: 'localhost', DEV_PORT: '5311' })).toEqual(
      new Set([network.publicUrl]),
    );
  });
});
