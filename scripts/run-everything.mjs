#!/usr/bin/env node
// Runs every check of the repository in one go and prints a PASS / FAIL / SKIP summary.
// Usually started through ./run-everything.sh, which first makes sure the right Node.js is used.
//
//   node scripts/run-everything.mjs            everything that can run on this machine
//   node scripts/run-everything.mjs --quick    install, lint, quick tests only (~1 min)
//   node scripts/run-everything.mjs --no-docker  skip the Docker integration tests
//   node scripts/run-everything.mjs --random   random property-test inputs instead of the fixed seed
//
// No AWS account or credentials are needed. Logs: logs/run-everything/<step>.log, summary:
// logs/run-everything/summary.md. Exit code 0 means no step failed.
import { spawn, spawnSync } from 'node:child_process';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOG_DIR = join(ROOT, 'logs', 'run-everything');
const args = new Set(process.argv.slice(2));
const QUICK = args.has('--quick');
const NO_DOCKER = args.has('--no-docker');
const WINDOWS = process.platform === 'win32';

/**
 * Property tests use one fixed fast-check seed here, so every machine tests the same inputs and
 * gets the same result (CI and plain `npm test` stay random to keep exploring). Override with
 * OPEN_ESTATE_FC_SEED=<n>, or pass --random.
 */
const FC_SEED = args.has('--random')
  ? undefined
  : (process.env['OPEN_ESTATE_FC_SEED'] ?? '20261107');
const SEED_ENV = FC_SEED === undefined ? {} : { OPEN_ESTATE_FC_SEED: FC_SEED };

if (args.has('--help') || args.has('-h')) {
  console.log(
    readFileSync(fileURLToPath(import.meta.url), 'utf8')
      .split('\n')
      .slice(1, 10)
      .join('\n'),
  );
  process.exit(0);
}

// --- Node.js version --------------------------------------------------------------------------

const REQUIRED = readFileSync(join(ROOT, '.nvmrc'), 'utf8').trim();
const [major, minor] = process.versions.node.split('.').map(Number);
const nodeOk = (major === 22 && minor >= 12) || major >= 24;
if (!nodeOk) {
  console.error(
    `\nNode.js ${process.versions.node} is too old (need 22.12+ or 24+; tested with ${REQUIRED}).\n` +
      'Start ./run-everything.sh instead: it downloads the right Node.js into .tools/ by itself.\n',
  );
  process.exit(1);
}

// --- helpers ----------------------------------------------------------------------------------

rmSync(LOG_DIR, { recursive: true, force: true });
mkdirSync(LOG_DIR, { recursive: true });

const color = process.stdout.isTTY && !process.env['NO_COLOR'];
const paint = (code, text) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
const STATUS = { PASS: paint(32, 'PASS'), FAIL: paint(31, 'FAIL'), SKIP: paint(33, 'SKIP') };

/** Runs a command, output only to the step's log file. Resolves to the exit code. */
function run(command, commandArgs, log, env = {}) {
  return new Promise((done) => {
    log.write(`$ ${command} ${commandArgs.join(' ')}\n\n`);
    const child = spawn(command, commandArgs, {
      cwd: ROOT,
      env: { ...process.env, CI: 'true', NG_CLI_ANALYTICS: 'false', ...env },
      shell: WINDOWS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.on('error', (error) => {
      log.write(`\n${error.stack}\n`);
      done(1);
    });
    child.on('close', (code) => done(code ?? 1));
  });
}

const npm = (...a) => ['npm', a];
const npx = (...a) => ['npx', ['--no-install', ...a]];

function freePort() {
  return new Promise((done, fail) => {
    const server = createServer();
    server.unref();
    server.on('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;
const KEY_LINE =
  /^(FAIL |\s+✘ |\s+● |\s+\{ seed: |\s+Counterexample: |.*error TS\d+|.*\[ERROR\]|\s+\S+\.(ts|html|scss):\d+:\d+:|\s+\d+:\d+\s+error\s|\/\S+\.(ts|js|mjs)$|\[warn\] |.*Error: |npm (ERR!|error) |BAD |\s+\d+\) \[[\w-]+\] › |\s+\[[\w-]+\] › |\s+\d+ (failed|flaky)$)/;

/**
 * The lines that matter in a failed step's log: failing suites and tests, fast-check seeds with a
 * ready-to-run replay command, TypeScript errors. Falls back to the last lines of the log.
 */
function failureDigest(logPath) {
  const lines = readFileSync(logPath, 'utf8').replace(ANSI, '').trimEnd().split('\n');
  const key = [...new Set(lines.filter((line) => KEY_LINE.test(line)).map((l) => l.slice(0, 300)))];
  const failedFiles = [
    ...new Set(lines.map((l) => /^FAIL (?:\S+ )?(packages\/\S+)/.exec(l)?.[1]).filter(Boolean)),
  ];
  const replays = lines
    .map((l) => /\{ seed: (-?\d+), path: "([^"]+)"/.exec(l))
    .filter(Boolean)
    .map(
      ([, seed, path]) =>
        `replay: OPEN_ESTATE_TEST_TIER=full OPEN_ESTATE_FC_SEED=${seed} OPEN_ESTATE_FC_PATH="${path}" npx jest ${failedFiles[0] ?? '<file>'}`,
    );
  const picked = key.length > 0 ? [...key.slice(0, 30), ...new Set(replays)] : lines.slice(-25);
  return picked.join('\n      ');
}

async function waitFor(url, timeoutMs, init) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, init);
      if (response.ok) return true;
    } catch {
      // not up yet
    }
    await sleep(1000);
  }
  return false;
}

// --- steps ------------------------------------------------------------------------------------

/** Starts the local demo server on a free port and calls every public entry point once. */
async function smokeLocalDemo(log) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ['packages/devserver/dist/main.js'], {
    cwd: ROOT,
    env: { ...process.env, DEV_PORT: String(port), DEV_QUIET: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.pipe(log, { end: false });
  server.stderr.pipe(log, { end: false });
  try {
    if (!(await waitFor(`${base}/health`, 30_000))) {
      log.write('\nlocal demo did not answer /health within 30 s\n');
      return 1;
    }
    const mcpInit = {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    };
    const checks = [
      ['GET /health', `${base}/health`, undefined, (b) => b.includes('"ok"')],
      [
        'GET /api/listings',
        `${base}/api/listings?pageSize=3`,
        undefined,
        (b) => b.includes('"items"'),
      ],
      [
        'GET /api/openapi.json',
        `${base}/api/openapi.json`,
        undefined,
        (b) => b.includes('"openapi"'),
      ],
      ['POST /mcp tools/list', `${base}/mcp`, mcpInit, (b) => b.includes('search_listings')],
      [
        'GET /management/openapi.json',
        `${base}/management/openapi.json`,
        undefined,
        (b) => b.includes('"openapi"'),
      ],
      [
        // The SPA's runtime config follows the (random) port instead of a hard-coded 4310.
        'GET /runtime-config.json',
        `${base}/runtime-config.json`,
        undefined,
        (b) => b.includes(`"issuer": "${base}/oidc"`),
      ],
      [
        'GET /oidc discovery',
        `${base}/oidc/.well-known/openid-configuration`,
        undefined,
        (b) => b.includes('authorization_endpoint'),
      ],
    ];
    let failed = 0;
    for (const [name, url, init, expect] of checks) {
      let line;
      try {
        const response = await fetch(url, init);
        const body = await response.text();
        const ok = response.ok && expect(body);
        if (!ok) failed++;
        line = `${ok ? 'ok  ' : 'BAD '} ${name} -> ${response.status} ${body.slice(0, 160).replace(/\s+/g, ' ')}`;
      } catch (error) {
        failed++;
        line = `BAD  ${name} -> ${error.message}`;
      }
      log.write(`\n${line}`);
    }
    log.write('\n');
    return failed === 0 ? 0 : 1;
  } finally {
    server.kill('SIGTERM');
  }
}

/**
 * Why the browser tests cannot run here, or nothing: they need a Chromium for Playwright
 * (`npm run test:browser:install`) or PLAYWRIGHT_CHROMIUM_EXECUTABLE pointing to one.
 */
function browserSkipReason() {
  const custom = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE']?.trim();
  if (custom) {
    return existsSync(custom)
      ? undefined
      : `PLAYWRIGHT_CHROMIUM_EXECUTABLE=${custom} does not exist`;
  }
  try {
    const { chromium } = createRequire(join(ROOT, 'package.json'))('playwright-core');
    return existsSync(chromium.executablePath())
      ? undefined
      : 'no Chromium for Playwright (run `npm run test:browser:install` once)';
  } catch {
    return 'Playwright is not installed';
  }
}

/** Playwright tests of the SPA against their own local demo, on free ports. */
async function browserTests(log) {
  const [frontendPort, devPort] = [await freePort(), await freePort()];
  return run(...npx('playwright', 'test', '-c', 'packages/browser-tests'), log, {
    BROWSER_TEST_FRONTEND_PORT: String(frontendPort),
    BROWSER_TEST_DEV_PORT: String(devPort),
  });
}

function dockerAvailable() {
  const probe = spawnSync('docker', ['info'], { stdio: 'ignore', shell: WINDOWS });
  return probe.status === 0;
}

/** DynamoDB Local + OpenSearch in Docker on free ports, then `test:integration`. Always cleans up. */
async function integrationTests(log) {
  const [dynamoPort, searchPort] = [await freePort(), await freePort()];
  const suffix = `${process.pid}`;
  const dynamo = `oe-dynamodb-${suffix}`;
  const search = `oe-opensearch-${suffix}`;
  const docker = (...a) => run('docker', a, log);
  try {
    if (
      (await docker(
        'run',
        '--rm',
        '-d',
        '--name',
        dynamo,
        '-p',
        `${dynamoPort}:8000`,
        'amazon/dynamodb-local',
      )) !== 0
    )
      return 1;
    if (
      (await docker(
        'run',
        '--rm',
        '-d',
        '--name',
        search,
        '-p',
        `${searchPort}:9200`,
        '-e',
        'discovery.type=single-node',
        '-e',
        'DISABLE_SECURITY_PLUGIN=true',
        '-e',
        'OPENSEARCH_JAVA_OPTS=-Xms512m -Xmx512m',
        'opensearchproject/opensearch:2.19.2',
      )) !== 0
    )
      return 1;
    log.write('\nwaiting for OpenSearch (up to 180 s) …\n');
    if (!(await waitFor(`http://127.0.0.1:${searchPort}`, 180_000))) {
      log.write('OpenSearch did not start in time\n');
      return 1;
    }
    return await run(
      ...npx('jest', '--forceExit', '--testPathPatterns', '\\.integration\\.test\\.ts$'),
      log,
      {
        OPEN_ESTATE_TEST_TIER: 'full',
        DYNAMODB_ENDPOINT: `http://127.0.0.1:${dynamoPort}`,
        OPENSEARCH_ENDPOINT: `http://127.0.0.1:${searchPort}`,
      },
    );
  } finally {
    await docker('rm', '-f', dynamo, search);
  }
}

/**
 * Steps in order. `needs` names steps that must have passed; otherwise the step is skipped.
 * `skip` returns a reason to skip on this machine, or nothing.
 */
const STEPS = [
  {
    id: 'install',
    title: 'Install dependencies (npm ci)',
    cmd: npm('ci', '--no-audit', '--no-fund'),
  },
  {
    id: 'lint',
    title: 'Lint (eslint, prettier, config check)',
    cmd: npm('run', 'lint'),
    needs: ['install'],
  },
  {
    id: 'test-quick',
    title: 'Tests, quick tier (npm test)',
    cmd: npx('jest', '--silent'),
    env: SEED_ENV,
    needs: ['install'],
    only: 'quick',
  },
  {
    id: 'build',
    title: 'Build (TypeScript + Angular)',
    cmd: npm('run', 'build'),
    needs: ['install'],
  },
  {
    id: 'typecheck',
    // After the build: packages/loadtest imports from @open-estate/infra/dist.
    title: 'Type-check tests',
    cmd: npm('run', 'typecheck:tests'),
    needs: ['build'],
  },
  {
    id: 'test-full',
    title: 'Tests, full tier (npm run test:full)',
    cmd: npx('jest', '--silent'),
    env: { OPEN_ESTATE_TEST_TIER: 'full', ...SEED_ENV },
    needs: ['install'],
  },
  {
    id: 'synth',
    title: 'CDK synth, all stacks (no AWS access)',
    cmd: npm('run', 'synth'),
    needs: ['build'],
  },
  {
    id: 'smoke',
    title: 'Local demo smoke test (APIs, MCP, login)',
    fn: smokeLocalDemo,
    needs: ['build'],
  },
  {
    id: 'browser',
    title: 'Browser tests (Playwright, local demo)',
    fn: browserTests,
    needs: ['install'],
    skip: browserSkipReason,
  },
  {
    id: 'integration',
    title: 'Integration tests (DynamoDB Local, OpenSearch)',
    fn: integrationTests,
    needs: ['install'],
    skip: () =>
      NO_DOCKER
        ? '--no-docker given'
        : dockerAvailable()
          ? undefined
          : 'Docker not available on this machine',
  },
  {
    id: 'e2e',
    title: 'End-to-end tests against a deployed stack',
    cmd: npx('jest', '--forceExit', '--runInBand', '--testPathPatterns', '\\.e2e\\.test\\.ts$'),
    env: { OPEN_ESTATE_TEST_TIER: 'full' },
    needs: ['install'],
    skip: () =>
      process.env['OPEN_ESTATE_E2E_ENV']
        ? undefined
        : 'needs AWS and a deployed stack (OPEN_ESTATE_E2E_ENV)',
  },
].filter((step) =>
  QUICK ? ['install', 'lint', 'test-quick'].includes(step.id) : step.only !== 'quick',
);

// --- main -------------------------------------------------------------------------------------

console.log(
  `\nOpenEstate: run everything${QUICK ? ' (--quick)' : ''} — Node ${process.versions.node}, ${process.platform}`,
);
console.log(
  `Property tests: ${FC_SEED === undefined ? 'random inputs (--random)' : `fixed seed ${FC_SEED} (same inputs on every machine)`}`,
);
console.log(`Logs: ${relative(ROOT, LOG_DIR)}/\n`);

const results = [];
const passed = new Set();
const started = Date.now();

for (const [index, step] of STEPS.entries()) {
  const label = `[${index + 1}/${STEPS.length}] ${step.title}`;
  const missing = (step.needs ?? []).filter((id) => !passed.has(id));
  const reason = missing.length > 0 ? `needs ${missing.join(', ')} to pass first` : step.skip?.();
  if (reason) {
    console.log(`${STATUS.SKIP}  ${label} — ${reason}`);
    results.push({ step, status: 'SKIP', note: reason, seconds: 0 });
    continue;
  }
  // Live "...." line only on a terminal; piped output (CI, agents) gets one line per step.
  if (process.stdout.isTTY) process.stdout.write(`....  ${label}`);
  const logPath = join(LOG_DIR, `${step.id}.log`);
  const log = createWriteStream(logPath);
  const t0 = Date.now();
  const code = step.fn ? await step.fn(log) : await run(...step.cmd, log, step.env);
  await new Promise((r) => log.end(r));
  const seconds = Math.round((Date.now() - t0) / 1000);
  const status = code === 0 ? 'PASS' : 'FAIL';
  if (status === 'PASS') passed.add(step.id);
  process.stdout.write(
    `${process.stdout.isTTY ? '\r' : ''}${STATUS[status]}  ${label} (${seconds} s)\n`,
  );
  results.push({ step, status, note: relative(ROOT, logPath), seconds });
  if (status === 'FAIL') {
    console.log(`      from ${relative(ROOT, logPath)}:\n      ${failureDigest(logPath)}\n`);
  }
}

const failed = results.filter((r) => r.status === 'FAIL');
const total = Math.round((Date.now() - started) / 1000);
const summary = [
  `# run-everything summary`,
  '',
  `Node ${process.versions.node}, ${process.platform}, ${total} s${QUICK ? ', --quick' : ''}, fast-check seed ${FC_SEED ?? 'random'}`,
  '',
  '| Step | Result | Time | Log / reason |',
  '| --- | --- | --- | --- |',
  ...results.map((r) => `| ${r.step.title} | ${r.status} | ${r.seconds} s | ${r.note} |`),
  '',
  failed.length === 0
    ? 'RESULT: OK, no step failed.'
    : `RESULT: FAILED (${failed.map((r) => r.step.id).join(', ')}).`,
  '',
].join('\n');
writeFileSync(join(LOG_DIR, 'summary.md'), summary);

console.log(
  `\n${failed.length === 0 ? paint(32, 'RESULT: OK') : paint(31, 'RESULT: FAILED')} in ${total} s`,
);
console.log(`Summary: ${relative(ROOT, join(LOG_DIR, 'summary.md'))}\n`);
process.exit(failed.length === 0 ? 0 : 1);
