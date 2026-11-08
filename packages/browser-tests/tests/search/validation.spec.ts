import { LISTINGS } from '../../support/demo-listings';
import { expect, test } from '../../support/fixtures';
import { isSearchRequest } from '../../support/search-page';

// Validation before any API call (Req 7.2): invalid input names and focuses the field, keeps
// everything as typed and sends nothing. The same rules apply to hand-edited search URLs.

test.describe('form validation', () => {
  /** Records Search_API list requests, to prove that invalid input sends none. */
  function recordSearches(page: import('@playwright/test').Page): string[] {
    const urls: string[] = [];
    page.on('request', (request) => {
      if (isSearchRequest(request.url())) urls.push(request.url());
    });
    return urls;
  }

  test('minimum above maximum price: names the field, focuses it, sends nothing', async ({
    page,
    search,
  }) => {
    const searches = recordSearches(page);
    await search.goto();
    await search.priceMin.fill('500000');
    await search.priceMax.fill('100000');
    await search.submitButton.click();

    await expect(search.formErrors).toContainText(
      'The minimum must not be greater than the maximum.',
    );
    const invalid = search.form.locator('[aria-invalid="true"]');
    await expect(invalid).toHaveCount(1);
    await expect(invalid).toBeFocused();
    // The error is linked to the field for screen readers.
    const describedBy = await invalid.getAttribute('aria-describedby');
    expect(describedBy).toMatch(/^search-error-price(Min|Max)$/);
    await expect(page.locator(`[id="${describedBy}"]`)).toBeVisible();
    // Inputs stay as typed, nothing was searched, the URL is unchanged.
    await expect(search.priceMin).toHaveValue('500000');
    await expect(search.priceMax).toHaveValue('100000');
    await expect(search.results).toHaveCount(0);
    expect(searches).toEqual([]);
    expect(search.query().toString()).toBe('');
  });

  test('a non-numeric price is rejected with the allowed range', async ({ search }) => {
    await search.goto();
    await search.priceMin.fill('cheap');
    await search.submitButton.click();

    await expect(search.formErrors).toContainText('Minimum price:');
    await expect(search.formErrors).toContainText(
      'Enter an amount from 0.01 to 999,999,999.99 with at most two decimal places.',
    );
    await expect(search.priceMin).toBeFocused();
    await expect(search.priceMin).toHaveAttribute('aria-invalid', 'true');
  });

  test('a thousands separator is rejected, not read as a decimal ("400,000" ≠ 400)', async ({
    page,
    search,
  }) => {
    const searches = recordSearches(page);
    await search.goto();
    await search.priceMax.fill('400,000');
    await search.submitButton.click();

    await expect(search.formErrors).toContainText('Maximum price:');
    await expect(search.priceMax).toHaveAttribute('aria-invalid', 'true');
    expect(searches).toEqual([]);
  });

  test('correcting the input clears the errors and runs the search', async ({ search }) => {
    await search.goto();
    await search.priceMin.fill('500000');
    await search.priceMax.fill('100000');
    await search.submitButton.click();
    await expect(search.formErrors).toBeVisible();

    await search.priceMax.fill('700000');
    await search.submit();
    await expect(search.formErrors).toHaveCount(0);
    await expect(search.form.locator('[aria-invalid="true"]')).toHaveCount(0);
    // 500,000–700,000 €: only the HafenCity loft (615,000 €).
    await search.expectTitles([LISTINGS.hamburgHafencity.title]);
  });

  test('reports every invalid field at once and focuses the first one', async ({ search }) => {
    await search.goto();
    await search.priceMin.fill('abc');
    await search.priceMax.fill('-5');
    await search.submitButton.click();

    await expect(search.formErrors.getByRole('listitem')).toHaveCount(2);
    await expect(search.priceMin).toBeFocused();
    await expect(search.priceMax).toHaveAttribute('aria-invalid', 'true');
  });

  test('a city name longer than the API allows is rejected', async ({ search }) => {
    await search.goto();
    await search.city.fill('x'.repeat(201));
    await search.submitButton.click();
    await expect(search.formErrors).toContainText('City:');
    await expect(search.formErrors).toContainText('Enter at most 200 characters.');
  });
});

test.describe('hand-edited search URLs', () => {
  test('an invalid URL search shows the errors and sends nothing', async ({ page, search }) => {
    const searches: string[] = [];
    page.on('request', (request) => {
      if (isSearchRequest(request.url())) searches.push(request.url());
    });
    await search.goto({ offerType: 'SALE', priceMin: 'abc', roomsMin: '2' });

    await expect(search.formErrors).toContainText('Minimum price:');
    // The values from the URL are shown as they are, so the user can fix them.
    await expect(search.priceMin).toHaveValue('abc');
    await expect(search.roomsChip(2)).toBeChecked();
    await expect(search.resultCards).toHaveCount(0);
    expect(searches).toEqual([]);
  });

  test('an unknown offer type asks to choose between buying and renting', async ({ search }) => {
    await search.goto({ offerType: 'LEASE' });
    await expect(search.formErrors).toContainText('Choose whether to buy or rent.');
    await expect(search.offerType('For sale')).not.toBeChecked();
    await expect(search.offerType('For rent')).not.toBeChecked();
  });

  test('an unknown property group is rejected', async ({ search }) => {
    await search.goto({ offerType: 'SALE', group: 'castle' });
    await expect(search.formErrors).toContainText('This selection is not available.');
  });
});
