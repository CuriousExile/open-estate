#!/usr/bin/env node
// DEV ONLY: starts the local demo — the in-memory dev server (Search API, MCP, Management API,
// insecure local OIDC provider; packages/devserver) and the SPA via `ng serve --configuration
// local` (proxy to the dev server, local runtime-config.json). See docs/local-demo.md.
//
// Usage: npm run dev            (both)
//        npm run dev:server     (dev server only)
// Ctrl+C / SIGTERM stops both processes.
//
// Ports: DEV_PORT (dev server, default 4310) and DEV_FRONTEND_PORT (ng serve, default 4200), e.g.
//        DEV_PORT=5310 DEV_FRONTEND_PORT=5200 npm run dev
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 12)) {
  console.error(
    `[dev] Node ${process.versions.node}: the Angular CLI needs Node 22.12+ or 24+. ` +
      'Run `npm run dev:server` for the backend only.',
  );
  process.exit(1);
}

console.log('[dev] building packages/devserver (tsc -b) …');
const build = spawnSync(
  process.execPath,
  [require.resolve('typescript/bin/tsc'), '-b', 'packages/devserver'],
  {
    cwd: ROOT,
    stdio: 'inherit',
  },
);
if (build.status !== 0) process.exit(build.status ?? 1);

// Same validation and defaults as the dev server itself (DEV_HOST, DEV_PORT, DEV_FRONTEND_PORT,
// DEV_FRONTEND_ORIGIN). ng serve inherits the environment, so its proxy (dev/proxy.local.mjs)
// targets the same dev server.
const { readNetworkConfig } = require(join(ROOT, 'packages/devserver/dist/config.js'));
let network;
try {
  network = readNetworkConfig(process.env);
} catch (error) {
  console.error(`[dev] ${error.message}`);
  process.exit(1);
}
if (network.port === network.frontendPort) {
  console.error(`[dev] DEV_PORT and DEV_FRONTEND_PORT must differ (both ${network.port})`);
  process.exit(1);
}
const origin = new URL(network.frontendOrigin); // validated by readNetworkConfig
if (Number(origin.port || (origin.protocol === 'https:' ? 443 : 80)) !== network.frontendPort) {
  console.warn(
    `[dev] DEV_FRONTEND_ORIGIN=${network.frontendOrigin} does not use DEV_FRONTEND_PORT ` +
      `${network.frontendPort}; ng serve listens on ${network.frontendPort}.`,
  );
}
const HEALTH_URL = `${network.publicUrl}/health`;

const children = new Set();
let stopping = false;

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 3_000).unref();
}

function start(name, args, cwd) {
  const child = spawn(process.execPath, args, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, NG_CLI_ANALYTICS: 'false' },
  });
  children.add(child);
  child.on('exit', (code, signal) => {
    children.delete(child);
    if (!stopping) {
      console.error(`[dev] ${name} exited (${signal ?? code}); stopping the demo`);
      stop(code ?? 1);
    } else if (children.size === 0) {
      process.exit(0);
    }
  });
  return child;
}

async function waitForHealth(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(HEALTH_URL)).ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((done) => setTimeout(done, 250));
  }
  return false;
}

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

start('dev server', [join(ROOT, 'packages/devserver/dist/main.js')], ROOT);
if (!(await waitForHealth(30_000))) {
  console.error(`[dev] dev server did not answer ${HEALTH_URL}`);
  stop(1);
} else {
  const ng = require.resolve('@angular/cli/bin/ng.js', {
    paths: [join(ROOT, 'packages/frontend')],
  });
  start(
    'ng serve',
    [ng, 'serve', '--configuration', 'local', '--port', String(network.frontendPort)],
    join(ROOT, 'packages/frontend'),
  );
}
