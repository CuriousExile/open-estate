import { resetDemo } from '../../support/demo-server';
import { LISTINGS } from '../../support/demo-listings';
import { expect, test } from '../../support/fixtures';
import { manageBar } from '../../support/manage-bar';
import { AGENCIES, PortalPage, USERS } from '../../support/portal';
import { SearchPage } from '../../support/search-page';

// (De)activating listings from the public search (project `serial`: it changes what is public;
// each test on a freshly reset demo).

const KIEL = LISTINGS.kiel;
const SCHWABING = '[DEMO] 2-Zimmer-Wohnung in Schwabing';

test.beforeEach(async ({ request }) => {
  await resetDemo(request);
});

async function publicCount(request: import('@playwright/test').APIRequestContext, city: string) {
  const response = await request.get(
    `/api/listings?offerType=RENT&city=${encodeURIComponent(city)}`,
  );
  return ((await response.json()) as { items: unknown[] }).items.length;
}

test('the agency deactivates a listing in the search and activates it again', async ({
  page,
  request,
  search,
}) => {
  await new PortalPage(page).signIn(USERS.anna);
  await search.goto({ offerType: 'RENT', city: 'Kiel' });
  await search.openListing(KIEL.title);
  const bar = manageBar(page);

  await bar.deactivate.click();
  await expect(bar.notice).toHaveText(
    `${KIEL.title} is inactive now and no longer shown in the search.`,
  );
  await expect(bar.state).toHaveText('Inactive: no longer shown in the search.');
  expect(await publicCount(request, 'Kiel')).toBe(0);
  // The open detail stays, so the change can be undone right here.
  await bar.activate.click();
  await expect(bar.notice).toHaveText(`${KIEL.title} is active now and shown in the search.`);
  await expect(bar.state).toHaveText('Active: shown in the search.');
  expect(await publicCount(request, 'Kiel')).toBe(1);

  // Deactivated again and back to the results: the card follows (marked, with "Activate").
  await bar.deactivate.click();
  await expect(bar.state).toHaveText('Inactive: no longer shown in the search.');
  await search.backToResults.click();
  const card = search.card(KIEL.title);
  await expect(card).toContainText('Inactive: no longer shown in the search.');
  await expect(card.getByRole('button', { name: `Activate ${KIEL.title}` })).toBeVisible();
});

test('a result card deactivates and activates its listing; the next search drops it', async ({
  page,
  request,
  search,
}) => {
  await new PortalPage(page).signIn(USERS.anna);
  await search.goto({ offerType: 'RENT', city: 'Kiel' });
  const card = search.card(KIEL.title);
  await card.getByRole('button', { name: `Deactivate ${KIEL.title}` }).click();

  const notice = search.results.getByRole('status').filter({ hasText: 'inactive now' });
  await expect(notice).toHaveText(
    `${KIEL.title} is inactive now and no longer shown in the search.`,
  );
  await expect(card).toContainText('Inactive: no longer shown in the search.');
  expect(await publicCount(request, 'Kiel')).toBe(0);
  // Undo on the card.
  await card.getByRole('button', { name: `Activate ${KIEL.title}` }).click();
  await expect(search.results.getByRole('status').filter({ hasText: 'active now' })).toHaveText(
    `${KIEL.title} is active now and shown in the search.`,
  );
  await expect(card).not.toContainText('Inactive');
  expect(await publicCount(request, 'Kiel')).toBe(1);

  // Deactivated and searched again: gone from the results.
  await card.getByRole('button', { name: `Deactivate ${KIEL.title}` }).click();
  await expect(card).toContainText('Inactive: no longer shown in the search.');
  await search.submit();
  await search.waitForResults();
  await expect(search.results.getByRole('status')).toContainText('No listings match');
});

test('the change is a version of its own, visible in the portal history', async ({
  page,
  search,
}) => {
  await new PortalPage(page).signIn(USERS.max);
  await search.goto({ offerType: 'RENT', city: 'Kiel' });
  await search.openListing(KIEL.title);
  await manageBar(page).deactivate.click();
  await expect(manageBar(page).state).toHaveText('Inactive: no longer shown in the search.');

  await manageBar(page).open.click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(KIEL.title);
  await page.getByRole('tab', { name: 'History', exact: true }).click();
  const newest = page.getByRole('tabpanel').getByRole('listitem').first();
  await expect(newest).toContainText('Status changed');
  await expect(newest).toContainText(`Portal · User ${USERS.max.displayName} · Inactive`);
});

test('only the own agency’s listings can be managed', async ({ browser, consoleGuard, page }) => {
  // The Schwabing listing has a broken image on purpose (seed).
  consoleGuard.allow(/404 .*\/demo-media\/photos\/lost-in-the-move\.webp\)$/);
  consoleGuard.allow(/404 .*\/management\/listings\//);
  // Make a second agency public: reactivate Alpenblick.
  const admin = await browser.newPage();
  try {
    await new PortalPage(admin).signIn(
      USERS.paula,
      `/portal/admin/agencies/${AGENCIES.alpenblick.agencyId}`,
    );
    await admin.getByRole('button', { name: 'Reactivate agency' }).click();
    await expect(admin.getByRole('status')).toHaveText('The agency was reactivated.');
  } finally {
    await admin.close();
  }

  // Nordlicht's admin: no bar on Alpenblick's listing.
  await new PortalPage(page).signIn(USERS.anna);
  const search = new SearchPage(page);
  await expect
    .poll(
      async () => {
        await search.goto({ offerType: 'RENT', city: 'München' });
        return search.titles();
      },
      { timeout: 15_000 },
    )
    .toEqual([SCHWABING]);
  await expect(
    search.card(SCHWABING).getByRole('button', { name: /^(Deactivate|Activate) / }),
  ).toHaveCount(0);
  await search.openListing(SCHWABING);
  await expect(search.detailHeading).toBeFocused();
  await expect(manageBar(page).region).toHaveCount(0);

  // Alpenblick's admin: the bar on his listing, none on Nordlicht's.
  const sepp = await browser.newPage();
  try {
    await new PortalPage(sepp).signIn(USERS.sepp);
    const seppSearch = new SearchPage(sepp);
    await seppSearch.goto({ offerType: 'RENT', city: 'München' });
    await expect(
      seppSearch.card(SCHWABING).getByRole('button', { name: `Deactivate ${SCHWABING}` }),
    ).toBeVisible();
    await seppSearch.openListing(SCHWABING);
    await expect(manageBar(sepp).deactivate).toBeVisible();
    // Nordlicht's rentals in Berlin (manual and imported): no controls on any card. The lookup
    // leaves them out (200), it does not fail.
    const lookup = sepp.waitForResponse(
      (r) => new URL(r.url()).pathname === '/management/listings',
    );
    await seppSearch.goto({ offerType: 'RENT', city: 'Berlin' });
    expect((await lookup).status()).toBe(200);
    await seppSearch.waitForResults();
    await expect(
      seppSearch.results.getByRole('button', { name: /^(Deactivate|Activate) / }),
    ).toHaveCount(0);
    await seppSearch.goto({ offerType: 'RENT', city: 'Kiel' });
    await seppSearch.openListing(KIEL.title);
    await expect(seppSearch.detailHeading).toBeFocused();
    await expect(manageBar(sepp).region).toHaveCount(0);
    // An imported listing names its connector, not the agency: the Management API is asked and
    // refuses (404 for another agency's listing).
    const refused = sepp.waitForResponse((r) =>
      new URL(r.url()).pathname.startsWith('/management/listings/'),
    );
    await seppSearch.goto({ offerType: 'RENT', city: 'Berlin' });
    await seppSearch.openListing(LISTINGS.berlinCharlottenburg.title);
    expect((await refused).status()).toBe(404);
    await expect(manageBar(sepp).region).toHaveCount(0);
  } finally {
    await sepp.close();
  }
});
