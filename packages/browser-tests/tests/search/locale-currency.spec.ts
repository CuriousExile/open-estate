import { LISTINGS, titlesFor } from '../../support/demo-listings';
import { expect, test } from '../../support/fixtures';
import type { SearchPage } from '../../support/search-page';

// Language and display currency of the header as far as they affect the search: texts, number
// formats, the language of the listings (Search API `lang`), converted prices and price filters.

const languageSelect = (search: SearchPage) =>
  search.page.getByRole('button', { name: /^(Language|Sprache) / });
const currencySelect = (search: SearchPage) =>
  search.page.getByRole('button', { name: /^Display currency/ });

test.describe('language', () => {
  test('switching to Deutsch translates the UI within 1 s and keeps the search (Req 13.5)', async ({
    page,
    search,
  }) => {
    await search.goto({ offerType: 'SALE', city: 'Berlin' });
    await search.expectTitles([LISTINGS.berlinMitte.title]);
    const navigations: string[] = [];
    page.on('framenavigated', (frame) => navigations.push(frame.url()));

    await search.chooseOption(languageSelect(search), 'Deutsch');

    const requirement = { timeout: 1_000 };
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'Finde dein nächstes Zuhause',
      requirement,
    );
    const results = page.getByRole('region', { name: 'Suchergebnisse' });
    await expect(results).toContainText('Kaufpreis', requirement);
    await expect(results).toContainText('469.000 €', requirement);
    await expect(page.locator('html')).toHaveAttribute('lang', 'de');
    // No reload, the entered values stay.
    expect(navigations).toEqual([]);
    await expect.poll(() => search.query().get('city')).toBe('Berlin');
    await expect(page.getByRole('combobox', { name: 'Ort' })).toHaveValue('Berlin');
  });

  test('after the switch, searches ask the Search API for German listings (Req 13.10)', async ({
    page,
    search,
  }) => {
    await search.goto({ offerType: 'SALE', city: 'Berlin' });
    await search.chooseOption(languageSelect(search), 'Deutsch');
    // Listing content already shown stays in the language it was loaded in (known issue) …
    const results = page.getByRole('region', { name: 'Suchergebnisse' });
    await expect(results.getByRole('heading', { level: 3 })).toHaveText([
      LISTINGS.berlinMitte.title,
    ]);

    // … the next search delivers the German version.
    const german = page.waitForResponse(
      (r) => new URL(r.url()).pathname === '/api/listings' && r.url().includes('lang=de'),
    );
    await page.getByRole('button', { name: 'Suchen', exact: true }).click();
    await german;
    await expect(results.getByRole('heading', { level: 3 })).toHaveText([
      LISTINGS.berlinMitte.titleDe,
    ]);
  });

  test('the choice is remembered across reloads', async ({ page, search }) => {
    await search.goto();
    await search.chooseOption(languageSelect(search), 'Deutsch');
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('open-estate.locale')))
      .toBe('de');
    await page.reload();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Finde dein nächstes Zuhause');
    await expect(languageSelect(search)).toContainText('Deutsch');
  });

  test('messages use the number format of the language', async ({ page, search }) => {
    await search.goto();
    await search.chooseOption(languageSelect(search), 'Deutsch');
    await page.getByRole('textbox', { name: 'Mindestpreis' }).fill('abc');
    await page.getByRole('button', { name: 'Suchen', exact: true }).click();
    await expect(
      page.getByRole('form', { name: 'Immobiliensuche' }).getByRole('alert'),
    ).toContainText(
      'Gib einen Betrag von 0,01 bis 999.999.999,99 mit höchstens zwei Nachkommastellen ein.',
    );
  });

  test.describe('with a German browser', () => {
    test.use({ locale: 'de-DE' });

    test('starts in German without a stored choice', async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('html')).toHaveAttribute('lang', 'de');
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(
        'Finde dein nächstes Zuhause',
      );
    });
  });

  test.describe('with a browser language that is not offered', () => {
    test.use({ locale: 'fr-FR' });

    test('falls back to the default language English', async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('html')).toHaveAttribute('lang', 'en');
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Find your next home');
    });
  });
});

test.describe('display currency', () => {
  test('converts prices and shows the original amount; remembered across reloads', async ({
    page,
    search,
  }) => {
    await search.goto({ offerType: 'SALE' });
    await search.expectTitles(titlesFor('SALE'));
    await search.chooseOption(currencySelect(search), 'US Dollar');

    // 469,000 € × 1.16 (static demo rate) = 544,040 $.
    const card = search.card(LISTINGS.berlinMitte.title);
    await expect(card).toContainText('$544,040');
    await expect(card).toContainText('Original: €469,000');
    await expect(search.form.getByRole('group', { name: 'Price (USD)' })).toBeVisible();

    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('open-estate.currency')))
      .toBe('USD');
    await page.reload();
    await expect(currencySelect(search)).toContainText('US Dollar');
    await expect(search.card(LISTINGS.berlinMitte.title)).toContainText('$544,040');
  });

  test('price bounds are entered and sent in the display currency', async ({ search }) => {
    await search.goto();
    await search.chooseOption(currencySelect(search), 'US Dollar');
    await search.priceMax.fill('500000');
    const response = await search.submit();

    const sent = new URL(response.url()).searchParams;
    expect(sent.get('currency')).toBe('USD');
    expect(sent.get('convertCurrency')).toBe('true');
    // 500,000 $ ≈ 431,000 €: Rostock, Lübeck and Pattaya (≈ 110,800 €).
    await search.expectTitles([
      LISTINGS.rostock.title,
      LISTINGS.luebeck.title,
      LISTINGS.pattaya.title,
    ]);
    await expect.poll(() => search.query().get('currency')).toBe('USD');
  });

  test('a shared link with EUR bounds is converted into the display currency', async ({
    page,
    search,
  }) => {
    await page.addInitScript(() => localStorage.setItem('open-estate.currency', 'USD'));
    await search.goto({ offerType: 'SALE', priceMax: '400000', currency: 'EUR' });

    // 400,000 € × 1.16 = 464,000 $; the URL follows, so the link stays consistent.
    await expect(search.priceMax).toHaveValue('464000');
    await expect.poll(() => search.query().get('currency')).toBe('USD');
    await expect.poll(() => search.query().get('priceMax')).toBe('464000');
    await search.expectTitles([
      LISTINGS.rostock.title,
      LISTINGS.luebeck.title,
      LISTINGS.pattaya.title,
    ]);
  });
});
