const { readdirSync } = require('node:fs');
const path = require('node:path');

/**
 * Test tiers (see CONTRIBUTING.md → Tests):
 *
 * - quick (default, `npm test`): every area except `infra`, without the suites flagged in
 *   FULL_ONLY, and property tests capped at OPEN_ESTATE_QUICK_RUNS runs (default 10). For the
 *   edit-test loop.
 * - full (`npm run test:full`, CI): everything, property tests with the run counts they ask for.
 *   Run before a commit / PR as the final check.
 *
 * Each test file belongs to exactly one functional area (a Jest project): run one area with
 * `npm run test:<area>` or `npx jest --selectProjects <area>`. A test file outside every area
 * fails the config load, so new test directories cannot be skipped silently.
 */
const TIER = process.env['OPEN_ESTATE_TEST_TIER'] === 'full' ? 'full' : 'quick';

/** Functional areas: test directories (relative to the repository root) per Jest project. */
const AREAS = {
  shared: ['packages/shared/test'],
  search: [
    'packages/core/test/search',
    'packages/core/test/read-model',
    'packages/core/test/indexer',
    'packages/core/test/access',
    'packages/core/test/usage',
    'packages/api/test',
    'packages/mcp/test',
  ],
  management: [
    'packages/core/test/management',
    'packages/core/test/admin-operations',
    'packages/core/test/deletion',
    'packages/management/test',
    'packages/admin/test',
  ],
  ingestion: ['packages/ingestion/test', 'packages/core/test/content'],
  platform: [
    'packages/core/test/config',
    'packages/core/test/observability',
    'packages/devserver/test',
    'packages/loadtest/test',
  ],
  frontend: ['packages/frontend/test'],
  // CDK synth assertions: slow and only relevant for infrastructure changes.
  infra: ['packages/infra/test'],
};

/** Areas that only run in the full tier (or explicitly via `npm run test:<area>`). */
const FULL_ONLY_AREAS = ['infra'];

/**
 * Single suites that only run in the full tier: slow and covered by a faster check, or testing
 * test tooling rather than product code. Keep each entry justified.
 */
const FULL_ONLY = [
  // Same script as `npm run check:config`, which `npm run lint` already runs.
  'packages/core/test/config/hardcoded-config-check.test.ts',
  // Spawns the Angular template parser over all templates (~3 s); i18n lint, not behaviour.
  'packages/frontend/test/template-i18n-lint.test.ts',
  // Tests the shared fast-check arbitraries (test tooling), ~5 s.
  'packages/shared/test/management-arbitraries.test.ts',
];

/** Need running services or a deployed stack; skipped without them, so full tier only. */
const EXTERNAL = ['\\.integration\\.test\\.ts$', '\\.e2e\\.test\\.ts$'];

const ROOT = __dirname;
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function testFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : testFiles(full);
    return entry.name.endsWith('.test.ts') ? [full] : [];
  });
}

function assertEveryTestHasAnArea() {
  const dirs = Object.values(AREAS).flat();
  const packages = readdirSync(path.join(ROOT, 'packages'));
  const orphans = packages
    .map((p) => path.join(ROOT, 'packages', p, 'test'))
    .filter((dir) => {
      try {
        return readdirSync(dir) && true;
      } catch {
        return false;
      }
    })
    .flatMap(testFiles)
    .map((file) => path.relative(ROOT, file))
    .filter((file) => !dirs.some((dir) => file.startsWith(dir + path.sep)));
  if (orphans.length > 0) {
    throw new Error(
      `Test files outside every area in jest.config.js (add their directory to AREAS):\n  ${orphans.join('\n  ')}`,
    );
  }
}

assertEveryTestHasAnArea();

// The quick tier maps `fast-check` to a wrapper that requires the real library by absolute path.
process.env['OPEN_ESTATE_FAST_CHECK_PATH'] = require.resolve('fast-check');

const common = {
  testEnvironment: 'node',
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.test.json' }],
  },
  // Tests run against package sources, not build output.
  moduleNameMapper: {
    '^@open-estate/([^/]+)$': '<rootDir>/packages/$1/src',
    ...(TIER === 'quick' && { '^fast-check$': '<rootDir>/test-support/fast-check-quick.js' }),
  },
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
};

const ignored =
  TIER === 'full' ? [] : [...EXTERNAL, ...FULL_ONLY.map((f) => `<rootDir>/${escape(f)}$`)];

// `npm run test:<area>` selects an area explicitly; it runs even if it is full-only.
const selected = process.argv.includes('--selectProjects');

const projects = Object.entries(AREAS)
  .filter(([name]) => TIER === 'full' || selected || !FULL_ONLY_AREAS.includes(name))
  .map(([name, dirs]) => ({
    ...common,
    displayName: name,
    roots: dirs.map((dir) => `<rootDir>/${dir}`),
    testMatch: ['**/*.test.ts'],
    testPathIgnorePatterns: ['/node_modules/', ...ignored],
  }));

/** @type {import('jest').Config} */
module.exports = {
  projects,
  // Per-run TMPDIR: catches the `cdk.out*` dirs of CDK apps synthesized without an `outdir`.
  globalSetup: '<rootDir>/jest.global-setup.js',
  globalTeardown: '<rootDir>/jest.global-teardown.js',
  collectCoverageFrom: ['packages/*/src/**/*.ts'],
};
