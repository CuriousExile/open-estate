import { LISTINGS, titlesFor } from '../../support/demo-listings';
import { expect, test } from '../../support/fixtures';
import { manageBar } from '../../support/manage-bar';
import { PortalPage, USERS } from '../../support/portal';

// Managing listings from the public search (read-only here): signed-in agency users and platform
// admins get controls on the result cards and a manage bar above the listing detail; anonymous
// visitors get nothing — not even a request to the Management API or the identity provider.
// Status changes: manage.serial.spec.ts.

const KIEL = LISTINGS.kiel;

test('anonymous visitors see no manage bar and cause no portal requests', async ({
  page,
  search,
}) => {
  const portalRequests: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/management') || url.pathname.startsWith('/oidc')) {
      portalRequests.push(`${request.method()} ${url.pathname}`);
    }
  });
  await search.goto({ offerType: 'RENT', city: 'Kiel' });
  await search.waitForResults();
  await expect(search.results.getByRole('button', { name: /^(Deactivate|Activate) / })).toHaveCount(
    0,
  );
  await search.openListing(KIEL.title);
  await expect(search.detailHeading).toBeFocused();
  await expect(manageBar(page).region).toHaveCount(0);
  expect(portalRequests).toEqual([]);
});

test('signed in as the agency: result cards offer edit and deactivate, from one lookup per page', async ({
  page,
  search,
  searchApi,
}) => {
  await new PortalPage(page).signIn(USERS.anna);
  const lookups: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/management/listings')) lookups.push(url.pathname + url.search);
  });
  await search.goto({ offerType: 'RENT' });
  await search.expectTitles(titlesFor('RENT'));

  // All public rentals belong to the agency: every card can be managed.
  for (const title of titlesFor('RENT')) {
    await expect(
      search.card(title).getByRole('button', { name: `Deactivate ${title}` }),
    ).toBeVisible();
    await expect(search.card(title).getByRole('link', { name: `Edit ${title}` })).toBeVisible();
  }
  // One request for the whole page: GET /management/listings?ids=…
  await expect.poll(() => lookups.length).toBe(1);
  expect(lookups[0]).toMatch(/^\/management\/listings\?ids=/);
  const ids = new URLSearchParams(lookups[0]?.split('?')[1]).get('ids')?.split(',') ?? [];
  expect(ids).toHaveLength(titlesFor('RENT').length);

  // "Edit" on a card opens the portal form of that listing.
  const id = await searchApi.listingId(KIEL.title);
  await search
    .card(KIEL.title)
    .getByRole('link', { name: `Edit ${KIEL.title}` })
    .click();
  await expect(page).toHaveURL(new RegExp(`/portal/listings/${id}/edit$`));
});

test('signed in as the agency: the listing can be managed right from the search', async ({
  page,
  search,
  searchApi,
}) => {
  await new PortalPage(page).signIn(USERS.anna);
  await search.goto({ offerType: 'RENT', city: 'Kiel' });
  await search.openListing(KIEL.title);

  const bar = manageBar(page);
  await expect(bar.region).toBeVisible();
  await expect(bar.state).toHaveText('Active: shown in the search.');
  await expect(bar.deactivate).toBeVisible();
  const id = await searchApi.listingId(KIEL.title);
  await expect(bar.open).toHaveAttribute('href', `/portal/listings/${id}`);

  // "Edit listing" opens the portal form of this listing.
  await bar.edit.click();
  await expect(page).toHaveURL(new RegExp(`/portal/listings/${id}/edit$`));
  await expect(page.getByRole('heading', { level: 1, name: 'Edit listing' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue(KIEL.title);
});

test('the bar survives a reload of the search (session of the tab)', async ({ page, search }) => {
  await new PortalPage(page).signIn(USERS.max);
  await search.goto({ offerType: 'RENT', city: 'Kiel' });
  await search.openListing(KIEL.title);
  await expect(manageBar(page).region).toBeVisible();

  await page.reload();
  await expect(search.detailHeading).toHaveText(KIEL.title);
  // Agency members may (de)activate and edit too.
  await expect(manageBar(page).deactivate).toBeVisible();
  await expect(manageBar(page).edit).toBeVisible();
});

test('the public listing page /listings/:id has the bar too', async ({ page, searchApi }) => {
  await new PortalPage(page).signIn(USERS.anna);
  const id = await searchApi.listingId(KIEL.title);
  await page.goto(`/listings/${id}`);
  await expect(page.getByRole('article').getByRole('heading', { level: 2 })).toHaveText(KIEL.title);
  await expect(manageBar(page).deactivate).toBeVisible();
});

test('platform admins manage every listing from the search', async ({ page, search }) => {
  await new PortalPage(page).signIn(USERS.paula);
  await search.goto({ offerType: 'SALE', city: 'Berlin' });
  const mitte = LISTINGS.berlinMitte.title;
  await expect(
    search.card(mitte).getByRole('button', { name: `Deactivate ${mitte}` }),
  ).toBeVisible();
  await search.openListing(mitte);
  await expect(manageBar(page).deactivate).toBeVisible();
});

test('after signing out the bar is gone', async ({ page, search }) => {
  const portal = new PortalPage(page);
  await portal.signIn(USERS.anna);
  await portal.signOutButton.click();
  await expect(search.form).toBeVisible();

  const portalRequests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/management'))
      portalRequests.push(request.url());
  });
  await search.goto({ offerType: 'RENT', city: 'Kiel' });
  await search.openListing(KIEL.title);
  await expect(search.detailHeading).toBeFocused();
  await expect(manageBar(page).region).toHaveCount(0);
  expect(portalRequests).toEqual([]);
});
