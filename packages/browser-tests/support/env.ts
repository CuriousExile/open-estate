// Addresses of the demo the browser tests run against. Shared by playwright.config.ts and the
// tests (they also run in the worker processes, which read the same environment).

/** Port of the SPA (`ng serve`) started for the tests; not the `npm run dev` default 4200. */
export const FRONTEND_PORT = process.env['BROWSER_TEST_FRONTEND_PORT']?.trim() || '5200';
/** Port of the dev server (APIs, local OIDC provider); not the `npm run dev` default 4310. */
export const DEV_PORT = process.env['BROWSER_TEST_DEV_PORT']?.trim() || '5310';

export const BASE_URL = `http://127.0.0.1:${FRONTEND_PORT}`;
/** The dev server itself, e.g. for its test hooks; the SPA reaches it through the ng proxy. */
export const DEV_SERVER_URL = `http://127.0.0.1:${DEV_PORT}`;
