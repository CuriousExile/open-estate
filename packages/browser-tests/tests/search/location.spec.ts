import { CITIES, LISTINGS, titlesFor } from '../../support/demo-listings';
import { expect, test } from '../../support/fixtures';
import type { SearchPage } from '../../support/search-page';

// City autocomplete (combobox with suggestions from GET /api/locations) and the country filter of
// the header, which scopes both the search and the suggestions and is remembered.

const COUNTRY_STORAGE_KEY = 'open-estate.country';

function suggestions(search: SearchPage) {
  return search.page.getByRole('listbox', { name: 'City suggestions' });
}

function countrySelect(search: SearchPage) {
  return search.page.getByRole('button', { name: /^Country/ });
}

test.describe('city suggestions', () => {
  test('typing suggests matching cities with their listing count', async ({ search }) => {
    await search.goto();
    await search.city.fill('ber');

    const list = suggestions(search);
    await expect(list).toBeVisible();
    await expect(search.city).toHaveAttribute('aria-expanded', 'true');
    await expect(list.getByRole('option')).toHaveCount(1);
    await expect(list.getByRole('option')).toContainText('Berlin');
    await expect(list.getByRole('option')).toContainText('Germany · listings: 4');
  });

  test('keyboard: arrow down and Enter take a suggestion', async ({ search }) => {
    await search.goto();
    await search.city.pressSequentially('ham');
    await expect(suggestions(search).getByRole('option')).toHaveCount(1);
    await search.city.press('ArrowDown');
    await expect(search.city).toHaveAttribute('aria-activedescendant', /.+/);
    await search.city.press('Enter');

    await expect(search.city).toHaveValue('Hamburg');
    await expect(suggestions(search)).toBeHidden();
    await search.submit();
    await search.expectTitles([LISTINGS.hamburgWinterhude.title, LISTINGS.hamburgHafencity.title]);
  });

  test('a click takes a suggestion', async ({ search }) => {
    await search.goto();
    await search.city.fill('ki');
    await suggestions(search).getByRole('option', { name: /Kiel/ }).click();
    await expect(search.city).toHaveValue('Kiel');
    await expect(suggestions(search)).toBeHidden();
  });

  test('matching ignores case and diacritics ("LUB" finds Lübeck)', async ({ search }) => {
    await search.goto();
    await search.city.fill('LUB');
    await expect(suggestions(search).getByRole('option')).toHaveText([/Lübeck/]);
  });

  test('Escape closes the suggestions and keeps the typed text', async ({ search }) => {
    await search.goto();
    await search.city.fill('ber');
    await expect(suggestions(search)).toBeVisible();
    await search.city.press('Escape');
    await expect(suggestions(search)).toBeHidden();
    await expect(search.city).toHaveValue('ber');
  });

  test('free text without a suggestion is allowed', async ({ search }) => {
    await search.goto();
    await search.city.fill('Atlantis');
    await expect(suggestions(search).getByRole('option')).toHaveCount(0);
    await search.submit();
    await expect(search.results.getByRole('status')).toContainText('No listings match');
  });
});

test.describe('country filter', () => {
  test('offers "All countries" and the countries with public listings', async ({ search }) => {
    await search.goto();
    const select = countrySelect(search);
    await expect(select).toContainText('All countries');
    await select.click();
    const options = search.page.getByRole('listbox', { name: 'Country' }).getByRole('option');
    // Austria only has listings of the suspended agency, so it is not offered.
    await expect(options).toHaveText([/All countries/, /Germany\s*9/, /Thailand\s*2/]);
  });

  test('choosing a country re-runs the search with it', async ({ search }) => {
    await search.goto({ offerType: 'SALE' });
    await search.expectTitles(titlesFor('SALE'));

    const rerun = search.page.waitForResponse(
      (r) => new URL(r.url()).pathname === '/api/listings' && r.url().includes('country=TH'),
    );
    await search.chooseOption(countrySelect(search), 'Thailand');
    await rerun;
    await search.expectTitles([LISTINGS.pattaya.title]);
    await expect(countrySelect(search)).toContainText('Thailand');
  });

  test('the choice is remembered across reloads', async ({ page, search }) => {
    await search.goto();
    await search.chooseOption(countrySelect(search), 'Thailand');
    await expect
      .poll(() => page.evaluate((key) => localStorage.getItem(key), COUNTRY_STORAGE_KEY))
      .toBe('TH');

    await page.reload();
    await expect(countrySelect(search)).toContainText('Thailand');
    await search.chooseOfferType('For rent');
    await search.submit();
    await search.expectTitles([LISTINGS.pattaya.title, LISTINGS.bangkok.title]);

    await search.chooseOption(countrySelect(search), 'All countries');
    await search.expectTitles(titlesFor('RENT'));
  });

  test('"?country=TH" preselects the country without starting a search', async ({ search }) => {
    await search.goto({ country: 'TH' });
    await expect(countrySelect(search)).toContainText('Thailand');
    await expect(search.results).toHaveCount(0);
  });

  test('suggestions only list cities of the chosen country', async ({ search }) => {
    await search.goto({ country: 'TH' });
    await search.city.fill('pat');
    await expect(suggestions(search).getByRole('option')).toHaveText([/Pattaya/]);
    await search.city.fill('ber');
    await expect(suggestions(search).getByRole('option')).toHaveCount(0);

    await search.chooseOption(countrySelect(search), 'All countries');
    await search.city.fill('b');
    // Every city starting with "b", in both countries.
    const expected = [...CITIES.DE, ...CITIES.TH].filter((city) => /^b/i.test(city));
    await expect(suggestions(search).getByRole('option')).toHaveCount(expected.length);
  });
});
