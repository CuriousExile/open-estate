import { HIDDEN_CITIES, LISTINGS, titlesFor } from '../../support/demo-listings';
import { expect, test } from '../../support/fixtures';
import { isSearchRequest } from '../../support/search-page';

// Public search, basic flows: start page, offer types, main-bar filters, conjunctive filtering,
// empty results and the visibility rules (drafts and suspended agencies are never public).

test.describe('start page', () => {
  test('shows the hero, the brand and the search form with "For sale" preselected @mobile', async ({
    page,
    search,
  }) => {
    const searches: string[] = [];
    page.on('request', (request) => {
      if (isSearchRequest(request.url())) searches.push(request.url());
    });
    await search.goto();

    await expect(page).toHaveTitle(/Open Estate/);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Find your next home' }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open Estate' })).toBeVisible();
    await expect(search.offerType('For sale')).toBeChecked();
    await expect(search.offerType('For rent')).not.toBeChecked();
    await expect(search.roomsChip()).toBeChecked();
    await expect(search.city).toHaveValue('');
    // Nothing is searched before the user asks for it.
    await expect(search.results).toHaveCount(0);
    expect(searches).toEqual([]);
  });
});

test.describe('searching', () => {
  test('without filters lists every public listing for sale @mobile', async ({ search }) => {
    await search.goto();
    await search.submit();

    await search.expectTitles(titlesFor('SALE'));
    await expect.poll(() => Object.fromEntries(search.query())).toEqual({ offerType: 'SALE' });
    const card = search.card(LISTINGS.berlinMitte.title);
    await expect(card).toContainText('Berlin');
    await expect(card).toContainText('Price');
    await expect(card).toContainText('€469,000');
  });

  test('"For rent" lists every public rental with its cold rent', async ({ search }) => {
    await search.goto();
    await search.chooseOfferType('For rent');
    await search.submit();

    await search.expectTitles(titlesFor('RENT'));
    await expect.poll(() => search.query().get('offerType')).toBe('RENT');
    const card = search.card(LISTINGS.kiel.title);
    await expect(card).toContainText('Cold rent');
    await expect(card).toContainText('€890');
  });

  test('a listing with a sale and a rent offer appears under both offer types', async ({
    search,
  }) => {
    await search.goto({ offerType: 'SALE' });
    await expect(search.card(LISTINGS.hamburgHafencity.title)).toContainText('€615,000');
    await search.chooseOfferType('For rent');
    await search.submit();
    await expect(search.card(LISTINGS.hamburgHafencity.title)).toContainText('€1,950');
  });

  test('by city sends the city to the Search API and keeps it in the URL', async ({ search }) => {
    await search.goto();
    await search.city.fill('Hamburg');
    const response = await search.submit();

    expect(new URL(response.url()).searchParams.get('city')).toBe('Hamburg');
    await search.expectTitles([LISTINGS.hamburgWinterhude.title, LISTINGS.hamburgHafencity.title]);
    await expect.poll(() => search.query().get('city')).toBe('Hamburg');
  });

  test('combines filters conjunctively: offer type, city, rooms and property group', async ({
    search,
  }) => {
    await search.goto();
    await search.chooseOfferType('For rent');
    await search.city.fill('Berlin');
    await search.chooseRooms(3);
    await search.submit();
    // 3.5 rooms (apartment) and 5 rooms (office); the 2-room flat is filtered out.
    await search.expectTitles([
      LISTINGS.berlinCharlottenburg.title,
      LISTINGS.berlinKreuzbergOffice.title,
    ]);

    await search.chooseOption(search.group, 'Apartment');
    await expect(search.group).toContainText('Apartment');
    const response = await search.submit();
    expect(new URL(response.url()).searchParams.get('group')).toBe('apartment');
    await search.expectTitles([LISTINGS.berlinCharlottenburg.title]);
    await expect
      .poll(() => Object.fromEntries(search.query()))
      .toEqual({
        offerType: 'RENT',
        city: 'Berlin',
        group: 'apartment',
        roomsMin: '3',
      });
  });

  test('filters by maximum price across currencies (THB prices converted to EUR)', async ({
    search,
  }) => {
    await search.goto();
    await search.priceMax.fill('400000');
    const response = await search.submit();

    const sent = new URL(response.url()).searchParams;
    expect(sent.get('priceMax')).toBe('400000');
    expect(sent.get('currency')).toBe('EUR');
    expect(sent.get('convertCurrency')).toBe('true');
    // 349,000 € (Rostock and the Ackerstraße neighbour) and 395,000 €, plus the Pattaya condo: 4,200,000 THB ≈ 110,800 € at the demo rate.
    await search.expectTitles([
      LISTINGS.rostock.title,
      LISTINGS.luebeck.title,
      LISTINGS.pattaya.title,
      LISTINGS.berlinMitteNeighbour.title,
    ]);
    await expect.poll(() => search.query().get('currency')).toBe('EUR');
  });

  test('filters by a price range', async ({ search }) => {
    await search.goto();
    await search.priceMin.fill('400000');
    await search.priceMax.fill('700000');
    await search.submit();
    await search.expectTitles([LISTINGS.berlinMitte.title, LISTINGS.hamburgHafencity.title]);
  });

  test('accepts a decimal comma in the price', async ({ search }) => {
    await search.goto();
    await search.chooseOfferType('For rent');
    await search.priceMax.fill('1450,50');
    const response = await search.submit();
    expect(new URL(response.url()).searchParams.get('priceMax')).toBe('1450.50');
    // 890 € and 1,450 € in Germany, plus the Bangkok condo (45,000 THB ≈ 1,187 €); 32,000 THB
    // (Pattaya) ≈ 844 €.
    await search.expectTitles([
      LISTINGS.kiel.title,
      LISTINGS.berlinPrenzlauerBerg.title,
      LISTINGS.bangkok.title,
      LISTINGS.pattaya.title,
    ]);
  });

  test('shows a notice when nothing matches, and keeps the filters', async ({ search }) => {
    await search.goto();
    await search.city.fill('Atlantis');
    await search.submit();

    await search.waitForResults();
    await expect(search.results.getByRole('status')).toHaveText(
      'No listings match your search. Try widening the filters.',
    );
    await expect(search.resultCards).toHaveCount(0);
    await expect(search.city).toHaveValue('Atlantis');
  });

  test('runs the same search again when "Search" is clicked twice', async ({ search }) => {
    await search.goto();
    await search.submit();
    await search.expectTitles(titlesFor('SALE'));
    // Same URL, so no navigation — but a fresh request.
    await search.submit();
    await search.expectTitles(titlesFor('SALE'));
  });
});

test.describe('visibility', () => {
  for (const [reason, cities] of Object.entries(HIDDEN_CITIES)) {
    for (const city of cities) {
      test(`${city} has no public listing (${reason})`, async ({ search }) => {
        for (const offerType of ['SALE', 'RENT'] as const) {
          await search.goto({ offerType, city });
          await search.waitForResults();
          await expect(search.results.getByRole('status')).toContainText('No listings match');
        }
      });
    }
  }

  // Known seed bug: the portal edit of CRM-4711 in packages/devserver/src/seed/seed.ts sets a new
  // title without `markDemoContent`, so one public listing is not marked as demo data although
  // docs/local-demo.md promises "Every title starts with [DEMO]". Remove `test.fail` once fixed.
  test('every public listing is marked as demo data', async ({ search }) => {
    test.fail(true, 'seed: portal edit of CRM-4711 drops the [DEMO] title prefix');
    for (const offerType of ['SALE', 'RENT'] as const) {
      await search.goto({ offerType });
      const titles = await search.titles();
      expect(titles.length).toBeGreaterThan(0);
      for (const title of titles) expect(title).toMatch(/^\[DEMO\] /);
    }
  });
});
