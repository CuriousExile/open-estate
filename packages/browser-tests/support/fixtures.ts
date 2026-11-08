import { test as base, expect, type APIRequestContext } from '@playwright/test';
import { SearchPage } from './search-page';

/**
 * Fails a test on browser errors it did not expect: `console.error` messages and uncaught
 * exceptions of the page. Tests that provoke errors on purpose (failing API, broken image) name
 * them with `allow(pattern)`.
 */
export interface ConsoleGuard {
  allow(pattern: RegExp): void;
}

/** Search_API helpers for test setup, through the SPA origin (same path the SPA uses). */
export interface SearchApi {
  /** Id of the public listing with this title (as delivered to the English UI). */
  listingId(title: string): Promise<string>;
}

interface Fixtures {
  consoleGuard: ConsoleGuard;
  search: SearchPage;
  searchApi: SearchApi;
}

/**
 * Console errors every page of the SPA produces today, so they are not attributed to single tests.
 * Each one is a finding (see packages/browser-tests/README.md → Known issues); remove the entry
 * once it is fixed.
 */
const KNOWN_NOISE: readonly RegExp[] = [
  // The SPA ships no favicon (index.html has no <link rel="icon">), so /favicon.ico is a 404.
  /^console\.error: Failed to load resource: .* 404 .*\(\S+\/favicon\.ico\)$/,
  // app.config.ts skips view transitions on purpose (reduced motion, no layout change); the
  // Angular router logs the rejected transition promise with console.error in dev mode only.
  /^console\.error: AbortError: Transition was skipped/,
  // Local demo only: Management API responses keep the stored demo image URLs
  // (https://demo-media.localhost/…), so the portal's preview cannot load them and shows the
  // placeholder (docs/local-demo.md → Demo images).
  /^console\.error: Failed to load resource: net::ERR_CONNECTION_REFUSED \(https:\/\/demo-media\.localhost\//,
];

export const test = base.extend<Fixtures>({
  consoleGuard: [
    async ({ page }, use) => {
      const allowed: RegExp[] = [...KNOWN_NOISE];
      const problems: string[] = [];
      page.on('console', (message) => {
        if (message.type() !== 'error') return;
        const url = message.location().url;
        problems.push(`console.error: ${message.text()}${url ? ` (${url})` : ''}`);
      });
      page.on('pageerror', (error) => problems.push(`uncaught: ${error.message}`));
      await use({ allow: (pattern) => void allowed.push(pattern) });
      const unexpected = problems.filter((text) => !allowed.some((p) => p.test(text)));
      expect(unexpected, 'unexpected errors in the browser console').toEqual([]);
    },
    { auto: true },
  ],
  search: async ({ page }, use) => {
    await use(new SearchPage(page));
  },
  searchApi: async ({ request }, use) => {
    await use(searchApi(request));
  },
});

export { expect };

function searchApi(request: APIRequestContext): SearchApi {
  return {
    async listingId(title) {
      for (const offerType of ['SALE', 'RENT']) {
        // Same language as the SPA (English UI), so titles match what the page shows.
        const response = await request.get(
          `/api/listings?offerType=${offerType}&pageSize=50&lang=en`,
        );
        expect(response.ok()).toBe(true);
        const body = (await response.json()) as { items: { id: string; title: string }[] };
        const match = body.items.find((item) => item.title === title);
        if (match !== undefined) return match.id;
      }
      throw new Error(`No public listing titled ${JSON.stringify(title)}`);
    },
  };
}
