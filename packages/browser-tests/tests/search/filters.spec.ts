import { LISTINGS, titlesFor } from '../../support/demo-listings';
import { expect, test } from '../../support/fixtures';
import type { SearchPage } from '../../support/search-page';

// Rooms chips of the search bar and the "More filters" dialog (area, max. rooms, postal code,
// 3D tour), rendered from the filter registry (packages/frontend/src/app/search/filters).

function moreFilters(search: SearchPage) {
  const dialog = search.page.getByRole('dialog', { name: 'More filters' });
  return {
    dialog,
    areaMin: dialog.getByRole('textbox', { name: 'Minimum area' }),
    areaMax: dialog.getByRole('textbox', { name: 'Maximum area' }),
    roomsMax: dialog.getByRole('textbox', { name: 'Max. rooms' }),
    postalCode: dialog.getByRole('textbox', { name: 'Postal code' }),
    hasTour: dialog.getByRole('switch', { name: /With 3D tour/ }),
    apply: dialog.getByRole('button', { name: 'Apply' }),
    reset: dialog.getByRole('button', { name: 'Reset' }),
    close: dialog.getByRole('button', { name: 'Close' }),
  };
}

async function openMoreFilters(search: SearchPage) {
  await search.moreFiltersButton.click();
  const more = moreFilters(search);
  await expect(more.dialog).toBeVisible();
  return more;
}

test.describe('rooms chips', () => {
  test('"4+" keeps listings with at least 4 rooms', async ({ search }) => {
    await search.goto();
    await search.chooseRooms(4);
    const response = await search.submit();

    expect(new URL(response.url()).searchParams.get('roomsMin')).toBe('4');
    // 4 rooms each; the 3.5-room HafenCity loft is out.
    await search.expectTitles([LISTINGS.hamburgWinterhude.title, LISTINGS.luebeck.title]);
    await expect.poll(() => search.query().get('roomsMin')).toBe('4');
  });

  test('"Any" removes the room filter again', async ({ search }) => {
    await search.goto({ offerType: 'SALE', roomsMin: '4' });
    await expect(search.roomsChip(4)).toBeChecked();
    await search.chooseRooms();
    await search.submit();
    await search.expectTitles(titlesFor('SALE'));
    await expect.poll(() => search.query().has('roomsMin')).toBe(false);
  });

  test('a half-room value from a link keeps filtering without a checked chip', async ({
    search,
  }) => {
    await search.goto({ offerType: 'RENT', roomsMin: '3.5' });
    for (const count of [1, 2, 3, 4, 5]) await expect(search.roomsChip(count)).not.toBeChecked();
    await expect(search.roomsChip()).not.toBeChecked();
    await search.expectTitles([
      LISTINGS.hamburgHafencity.title,
      LISTINGS.berlinCharlottenburg.title,
      LISTINGS.berlinKreuzbergOffice.title,
    ]);
  });
});

test.describe('"More filters"', () => {
  test('minimum area: applies, closes the dialog, counts the filter and searches', async ({
    search,
  }) => {
    await search.goto();
    const more = await openMoreFilters(search);
    await more.areaMin.fill('100');
    const response = search.page.waitForResponse(
      (r) => new URL(r.url()).pathname === '/api/listings',
    );
    await more.apply.click();

    expect(new URL((await response).url()).searchParams.get('areaMin')).toBe('100');
    await expect(more.dialog).toBeHidden();
    await expect(search.moreFiltersButton).toBeFocused();
    await expect(search.moreFiltersButton).toContainText('1 active');
    // 121, 112 and 118.4 m²; 82.5 m² (Berlin-Mitte), 58 m² (Rostock) and 68 m² (Pattaya) are out.
    await search.expectTitles([
      LISTINGS.hamburgWinterhude.title,
      LISTINGS.luebeck.title,
      LISTINGS.hamburgHafencity.title,
    ]);
    await expect.poll(() => search.query().get('areaMin')).toBe('100');
  });

  test('postal code finds the listing with exactly that code', async ({ search }) => {
    await search.goto();
    const more = await openMoreFilters(search);
    await more.postalCode.fill(LISTINGS.berlinMitte.postalCode);
    await more.apply.click();
    // The Ackerstraße neighbour has the same postal code.
    await search.expectTitles([LISTINGS.berlinMitte.title, LISTINGS.berlinMitteNeighbour.title]);
  });

  test('maximum rooms combines with the offer type', async ({ search }) => {
    await search.goto();
    await search.chooseOfferType('For rent');
    const more = await openMoreFilters(search);
    await more.roomsMax.fill('2');
    await more.apply.click();
    await search.expectTitles([
      LISTINGS.berlinPrenzlauerBerg.title,
      LISTINGS.kiel.title,
      LISTINGS.bangkok.title,
      LISTINGS.pattaya.title,
    ]);
  });

  test('"With 3D tour" finds nothing: the demo has no allowlisted tour provider', async ({
    search,
  }) => {
    await search.goto();
    const more = await openMoreFilters(search);
    await more.hasTour.check();
    await expect(more.hasTour).toBeChecked();
    await more.apply.click();

    await expect.poll(() => search.query().get('hasTour')).toBe('true');
    await search.waitForResults();
    await expect(search.results.getByRole('status')).toContainText('No listings match');
  });

  test('invalid input keeps the dialog open and names the field', async ({ page, search }) => {
    await search.goto();
    const more = await openMoreFilters(search);
    await more.areaMin.fill('200');
    await more.areaMax.fill('100');
    let searched = false;
    page.on('request', (r) => {
      if (new URL(r.url()).pathname === '/api/listings') searched = true;
    });
    await more.apply.click();

    await expect(more.dialog).toBeVisible();
    // Unlike the main bar (role="alert"), the dialog links the message to the focused field.
    const invalid = more.dialog.locator('[aria-invalid="true"]');
    await expect(invalid.first()).toBeFocused();
    await expect(invalid.first()).toHaveAccessibleDescription(
      'The minimum must not be greater than the maximum.',
    );
    expect(searched).toBe(false);

    await more.areaMax.fill('250');
    await more.apply.click();
    await expect(more.dialog).toBeHidden();
    await search.expectTitles([]);
  });

  test('Reset clears the filters of the dialog', async ({ search }) => {
    await search.goto({ offerType: 'SALE', areaMin: '100', postalCode: '22301' });
    await expect(search.moreFiltersButton).toContainText('2 active');
    const more = await openMoreFilters(search);
    await expect(more.areaMin).toHaveValue('100');
    await more.reset.click();
    await expect(more.areaMin).toHaveValue('');
    await expect(more.postalCode).toHaveValue('');
    await more.apply.click();

    await expect(search.moreFiltersButton).not.toContainText('active');
    await search.expectTitles(titlesFor('SALE'));
  });

  test('closing without "Apply" discards the draft', async ({ search }) => {
    await search.goto();
    const more = await openMoreFilters(search);
    await more.areaMin.fill('100');
    await more.close.click();
    await expect(more.dialog).toBeHidden();
    await expect(search.moreFiltersButton).toBeFocused();
    await expect(search.moreFiltersButton).not.toContainText('active');

    // Escape closes it as well.
    await openMoreFilters(search);
    await expect(more.areaMin).toHaveValue('');
    await search.page.keyboard.press('Escape');
    await expect(more.dialog).toBeHidden();
  });
});
