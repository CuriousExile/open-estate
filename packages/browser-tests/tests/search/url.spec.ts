import { LISTINGS } from '../../support/demo-listings';
import { expect, test } from '../../support/fixtures';

// A search lives in the URL: deep links open it with the form filled in, reload keeps it, and the
// browser history moves between searches.

test('a deep link opens the search with the form filled in', async ({ search }) => {
  await search.goto({ offerType: 'RENT', city: 'Kiel', roomsMin: '2' });

  await expect(search.offerType('For rent')).toBeChecked();
  await expect(search.city).toHaveValue('Kiel');
  await expect(search.roomsChip(2)).toBeChecked();
  await search.expectTitles([LISTINGS.kiel.title]);
});

test('a deep link with "More filters" values restores them and shows the badge', async ({
  search,
}) => {
  await search.goto({ offerType: 'SALE', areaMin: '100', postalCode: '22301' });
  await expect(search.moreFiltersButton).toContainText('2 active');
  await search.expectTitles([LISTINGS.hamburgWinterhude.title]);
});

test('reloading keeps the search and its results', async ({ page, search }) => {
  await search.goto();
  await search.city.fill('Hamburg');
  await search.submit();
  await search.expectTitles([LISTINGS.hamburgWinterhude.title, LISTINGS.hamburgHafencity.title]);

  await page.reload();
  await expect(search.city).toHaveValue('Hamburg');
  await search.expectTitles([LISTINGS.hamburgWinterhude.title, LISTINGS.hamburgHafencity.title]);
});

test('back and forward move between searches and restore the form', async ({ page, search }) => {
  await search.goto();
  await search.city.fill('Hamburg');
  await search.submit();
  await search.expectTitles([LISTINGS.hamburgWinterhude.title, LISTINGS.hamburgHafencity.title]);

  await search.chooseOfferType('For rent');
  await search.city.fill('Kiel');
  await search.submit();
  await search.expectTitles([LISTINGS.kiel.title]);

  await page.goBack();
  await expect(search.offerType('For sale')).toBeChecked();
  await expect(search.city).toHaveValue('Hamburg');
  await search.expectTitles([LISTINGS.hamburgWinterhude.title, LISTINGS.hamburgHafencity.title]);

  await page.goForward();
  await expect(search.offerType('For rent')).toBeChecked();
  await expect(search.city).toHaveValue('Kiel');
  await search.expectTitles([LISTINGS.kiel.title]);

  // Back to the start page: no results, the form is reset.
  await page.goBack();
  await page.goBack();
  await expect(search.results).toHaveCount(0);
  await expect(search.city).toHaveValue('');
  await expect(page.getByRole('heading', { level: 1, name: 'Find your next home' })).toBeVisible();
});

test('the brand link returns to the start page', async ({ page, search }) => {
  await search.goto({ offerType: 'SALE', city: 'Berlin' });
  await search.waitForResults();
  await page.getByRole('link', { name: 'Open Estate' }).click();

  await expect(page).toHaveURL(/\/$/);
  await expect(search.results).toHaveCount(0);
  await expect(search.city).toHaveValue('');
});

test('unknown query parameters are ignored', async ({ search }) => {
  await search.goto({ offerType: 'SALE', city: 'Kiel', utm_source: 'newsletter' });
  await search.waitForResults();
  await expect(search.results.getByRole('status')).toContainText('No listings match');
  await search.goto({ offerType: 'RENT', city: 'Kiel', utm_source: 'newsletter' });
  await search.expectTitles([LISTINGS.kiel.title]);
});
