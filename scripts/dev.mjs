#!/usr/bin/env node
// DEV ONLY: starts the local demo — the in-memory dev server (Search API, MCP, Management API,
// insecure local OIDC provider; packages/devserver) and the SPA via `ng serve --configuration
// local` (proxy to the dev server, local runtime-config.json). See docs/local-demo.md.
//
// Usage: npm run dev            (both)
//        npm run dev:server     (dev server only)
// Ctrl+C / SIGTERM stops both processes.
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const DEV_PORT = process.env.DEV_PORT ?? '4310';
const HEALTH_URL = `http://127.0.0.1:${DEV_PORT}/health`;

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
  start('ng serve', [ng, 'serve', '--configuration', 'local'], join(ROOT, 'packages/frontend'));
}
