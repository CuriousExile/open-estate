import type { Route } from '@playwright/test';
import { LISTINGS, titlesFor } from '../../support/demo-listings';
import { expect, test } from '../../support/fixtures';

// Failures of the Search API, simulated with request interception: every error is shown in the
// result area with a way to retry, and the search form keeps all entered values (Req 7.7). The
// start works without the optional endpoints (/meta, /locations).

const isSearch = (url: URL) => url.pathname === '/api/listings';

/** Browser log line of a failed request (Chromium logs every non-2xx fetch). */
const FAILED_RESOURCE = /Failed to load resource/;

test.describe('failing searches', () => {
  test('a server error offers "Try again", which recovers and keeps the filters', async ({
    consoleGuard,
    page,
    search,
  }) => {
    consoleGuard.allow(FAILED_RESOURCE);
    let fail = true;
    await page.route(isSearch, (route) =>
      fail ? route.fulfill({ status: 500, json: { code: 'INTERNAL' } }) : route.fallback(),
    );
    await search.goto();
    await search.chooseOfferType('For rent');
    await search.city.fill('Kiel');
    await search.submit();

    const alert = search.results.getByRole('alert');
    await expect(alert).toContainText(
      'The search service is currently unavailable. Please try again later.',
    );
    await expect(search.offerType('For rent')).toBeChecked();
    await expect(search.city).toHaveValue('Kiel');

    fail = false;
    await alert.getByRole('button', { name: 'Try again' }).click();
    await search.expectTitles([LISTINGS.kiel.title]);
    await expect(search.results.getByRole('alert')).toHaveCount(0);
  });

  test('an unreachable service says so', async ({ consoleGuard, page, search }) => {
    consoleGuard.allow(FAILED_RESOURCE);
    await page.route(isSearch, (route) => route.abort('connectionrefused'));
    await search.goto({ offerType: 'SALE' });
    await expect(search.results.getByRole('alert')).toContainText(
      'The search service could not be reached. Check your connection and try again.',
    );
  });

  test('rate limiting names the waiting time from Retry-After', async ({
    consoleGuard,
    page,
    search,
  }) => {
    consoleGuard.allow(FAILED_RESOURCE);
    await page.route(isSearch, (route) =>
      route.fulfill({
        status: 429,
        headers: { 'Retry-After': '7' },
        json: { code: 'RATE_LIMITED', message: 'Too many requests' },
      }),
    );
    await search.goto({ offerType: 'SALE' });
    await expect(search.results.getByRole('alert')).toContainText(
      'Too many searches in a short time. Please try again in 7 seconds.',
    );
  });

  test('a rejected request (4xx) asks to check the filters', async ({
    consoleGuard,
    page,
    search,
  }) => {
    consoleGuard.allow(FAILED_RESOURCE);
    await page.route(isSearch, (route) =>
      route.fulfill({
        status: 400,
        json: { errors: [{ code: 'INVALID_VALUE', message: 'bad', field: 'city' }] },
      }),
    );
    await search.goto({ offerType: 'SALE' });
    await expect(search.results.getByRole('alert')).toContainText(
      'The search could not be run with these filters. Please check them and try again.',
    );
  });

  test('an answer of unexpected shape is treated as a server error', async ({ page, search }) => {
    await page.route(isSearch, (route) => route.fulfill({ status: 200, json: { hello: 'world' } }));
    await search.goto({ offerType: 'SALE' });
    await expect(search.results.getByRole('alert')).toContainText(
      'The search service is currently unavailable.',
    );
  });

  test('no answer within 10 seconds is a timeout', async ({ page, search }) => {
    test.slow();
    const pending: Route[] = [];
    await page.route(isSearch, (route) => void pending.push(route));
    await search.goto({ offerType: 'SALE' });
    await expect(search.results.getByRole('status')).toHaveText('Searching listings…');
    await expect(search.results.getByRole('alert')).toContainText(
      'The search did not respond within 10 seconds. Your filters are kept — please try again.',
      { timeout: 15_000 },
    );
    // The page gave up on the request; answering it now must not change anything.
    for (const route of pending) await route.abort().catch(() => undefined);
  });

  test('a newer search supersedes a slow one', async ({ page, search }) => {
    const slow: Route[] = [];
    await page.route(isSearch, async (route) => {
      if (new URL(route.request().url()).searchParams.get('city') === 'Hamburg') {
        slow.push(route);
        return;
      }
      await route.fallback();
    });
    await search.goto();
    await search.city.fill('Hamburg');
    await search.submitButton.click();
    await expect(search.results.getByRole('status')).toHaveText('Searching listings…');

    await search.city.fill('');
    await search.chooseOfferType('For rent');
    await search.city.fill('Kiel');
    await search.submit();
    await search.expectTitles([LISTINGS.kiel.title]);
    // The old answer arrives late and must not replace the newer results.
    for (const route of slow) await route.fallback().catch(() => undefined);
    await page.waitForTimeout(500);
    await search.expectTitles([LISTINGS.kiel.title]);
  });
});

test.describe('start without optional endpoints', () => {
  test('without /api/meta the search still works; the group filter is hidden', async ({
    consoleGuard,
    page,
    search,
  }) => {
    consoleGuard.allow(FAILED_RESOURCE);
    consoleGuard.allow(/\[startup\] meta unavailable/); // logged by the app on purpose
    await page.route('**/api/meta', (route) => route.fulfill({ status: 503 }));
    await search.goto();
    await expect(search.group).toHaveCount(0);
    await search.submit();
    await search.expectTitles(titlesFor('SALE'));
  });

  test('without /api/locations there are no suggestions, but the search works', async ({
    consoleGuard,
    page,
    search,
  }) => {
    consoleGuard.allow(FAILED_RESOURCE);
    await page.route('**/api/locations**', (route) => route.fulfill({ status: 503 }));
    await search.goto();
    await search.city.fill('ber');
    const options = page.getByRole('listbox', { name: 'City suggestions' }).getByRole('option');
    await expect(options).toHaveCount(0);
    await search.city.fill('Berlin');
    await search.submit();
    await search.expectTitles([LISTINGS.berlinMitte.title]);
  });
});
