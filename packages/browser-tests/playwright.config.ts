import * as path from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { BASE_URL, DEV_PORT, FRONTEND_PORT } from './support/env';

// Browser tests of the SPA against the local demo (`npm run dev`: packages/devserver + ng serve).
// Playwright starts its own demo on separate ports, so a `npm run dev` on the default ports
// (4200/4310) can keep running. See packages/browser-tests/README.md.
//
// State: the demo keeps everything in memory. `setup` resets it to the seed. `search`,
// `search-mobile` and `portal` run in parallel and must not change what another test reads:
// search tests only read, portal tests read the seed or work on data they create themselves
// (never public, unique names). Tests that change seeded or public state live in
// `*.serial.spec.ts`; the `serial` project runs them one at a time after all others, each one
// starting from a reset.

const ROOT = path.resolve(__dirname, '..', '..');
const CI = Boolean(process.env['CI']);

/**
 * Chromium to use instead of Playwright's download (`npx playwright install chromium`), e.g. a
 * system Chromium where the download is blocked. Should match the Playwright release's major.
 */
const CHROMIUM = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE']?.trim() || undefined;

const SERIAL = /\.serial\.spec\.ts$/;
const desktop = { ...devices['Desktop Chrome'] };

export default defineConfig({
  testDir: './tests',
  outputDir: path.join(ROOT, 'logs', 'playwright', 'results'),
  fullyParallel: true,
  forbidOnly: CI,
  // One retry on CI to collect a trace; a test that passes only on retry still fails the run.
  retries: CI ? 1 : 0,
  failOnFlakyTests: CI,
  // Locally Playwright picks half the CPU cores.
  ...(CI && { workers: 2 }),
  timeout: 30_000,
  expect: { timeout: 7_500 },
  reporter: [
    [CI ? 'line' : 'list'],
    ['html', { outputFolder: path.join(ROOT, 'logs', 'playwright', 'report'), open: 'never' }],
  ],
  use: {
    baseURL: BASE_URL,
    // Deterministic texts and number/date formats; the SPA follows navigator.languages.
    locale: 'en-US',
    timezoneId: 'Europe/Berlin',
    colorScheme: 'light',
    reducedMotion: 'reduce',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...(CHROMIUM !== undefined && { launchOptions: { executablePath: CHROMIUM } }),
  },
  projects: [
    { name: 'setup', testMatch: /setup\/.*\.setup\.ts$/ },
    // Public search, everything except touch-only tests.
    {
      name: 'search',
      testMatch: 'search/**/*.spec.ts',
      testIgnore: SERIAL,
      grepInvert: /@touch/,
      dependencies: ['setup'],
      use: desktop,
    },
    // Phone layout (narrow viewport, touch): tests tagged @mobile, and @touch (touch input only).
    {
      name: 'search-mobile',
      testMatch: 'search/**/*.spec.ts',
      testIgnore: SERIAL,
      grep: /@mobile|@touch/,
      dependencies: ['setup'],
      use: { ...devices['Pixel 7'] },
    },
    // Agency portal and admin mode, in parallel with the search.
    {
      name: 'portal',
      testMatch: ['portal/**/*.spec.ts', 'admin/**/*.spec.ts'],
      testIgnore: SERIAL,
      dependencies: ['setup'],
      use: desktop,
    },
    // Changes to seeded or public state: one at a time, after everything else.
    {
      name: 'serial',
      testMatch: SERIAL,
      workers: 1,
      fullyParallel: false,
      dependencies: ['search', 'search-mobile', 'portal'],
      use: desktop,
    },
  ],
  webServer: {
    // scripts/dev.mjs builds packages/devserver, starts it and then `ng serve` (local config).
    command: 'node scripts/dev.mjs',
    cwd: ROOT,
    url: `${BASE_URL}/runtime-config.json`,
    env: {
      DEV_PORT,
      DEV_FRONTEND_PORT: FRONTEND_PORT,
      DEV_QUIET: '1',
      // POST /__test__/reset (packages/devserver/src/test-hooks.ts), used by `setup` and `serial`.
      DEV_TEST_HOOKS: '1',
      NG_CLI_ANALYTICS: 'false',
    },
    // A running demo has state from earlier runs; reuse it only on request.
    reuseExistingServer: process.env['BROWSER_TEST_REUSE_SERVER'] === '1',
    timeout: 240_000,
    stdout: 'ignore',
    stderr: 'pipe',
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
  },
});
