import type { APIRequestContext, Page } from '@playwright/test';
import { resetDemo } from '../../support/demo-server';
import { expect, test } from '../../support/fixtures';
import { AGENCIES, PortalPage, signIn, USERS } from '../../support/portal';
import { SearchPage } from '../../support/search-page';
import { unique } from '../../support/unique';

// Admin actions that change what everybody sees (project `serial`: one at a time, after the
// parallel projects, each on a freshly reset demo). The local demo applies suspensions and
// access changes within 5 s (access caches; 60 s in AWS), hence the polling.

const EFFECT = { timeout: 20_000, intervals: [500, 1_000] };

test.beforeEach(async ({ request }) => {
  await resetDemo(request);
});

/** Number of public listings for sale (all of them belong to Nordlicht in the seed). */
async function publicSales(request: APIRequestContext, city?: string): Promise<number | string> {
  const query = new URLSearchParams({ offerType: 'SALE', ...(city !== undefined && { city }) });
  const response = await request.get(`/api/listings?${query.toString()}`);
  if (!response.ok()) return `HTTP ${response.status()}`;
  return ((await response.json()) as { items: unknown[] }).items.length;
}

async function publicRentals(request: APIRequestContext, city: string): Promise<number> {
  const response = await request.get(
    `/api/listings?offerType=RENT&city=${encodeURIComponent(city)}`,
  );
  return ((await response.json()) as { items: unknown[] }).items.length;
}

function agencyPage(page: Page) {
  const manage = page.getByRole('region', { name: 'Manage agency' });
  return {
    manage,
    state: page.locator('section .head .badge').first(),
    suspend: manage.getByRole('button', { name: 'Suspend agency …' }),
    reactivate: manage.getByRole('button', { name: 'Reactivate agency' }),
    notice: manage.getByRole('status'),
  };
}

test('suspending an agency takes its listings offline and locks its users out; reactivating undoes it', async ({
  browser,
  consoleGuard,
  page,
  request,
}) => {
  consoleGuard.allow(/Failed to load resource: .* 403 /);
  expect(await publicSales(request)).toBe(7);
  await new PortalPage(page).signIn(
    USERS.paula,
    `/portal/admin/agencies/${AGENCIES.nordlicht.agencyId}`,
  );
  const agency = agencyPage(page);
  await agency.suspend.click();
  const dialog = page.getByRole('dialog', {
    name: `Suspend the agency ${AGENCIES.nordlicht.displayName}?`,
  });
  // 14 seeded plus the repost and the neighbour of the duplicate detection demo.
  await expect(dialog).toContainText('Affected listings: 16');
  await expect(dialog).toContainText('Affected users: 2');
  await dialog.getByRole('button', { name: 'Suspend', exact: true }).click();
  await expect(agency.notice).toContainText('The agency was suspended.');
  await expect(agency.state).toHaveText('Suspended');

  // Public: none of its listings (Req 1.8, 10.x).
  await expect.poll(() => publicSales(request), EFFECT).toBe(0);
  // Its users: refused.
  const anna = await browser.newPage();
  try {
    await signIn(anna, USERS.anna);
    await expect(anna.getByRole('alert', { name: 'Account not available' })).toBeVisible();
  } finally {
    await anna.close();
  }

  await agency.reactivate.click();
  await expect(agency.notice).toHaveText('The agency was reactivated.');
  await expect(agency.state).toHaveText('Active');
  await expect.poll(() => publicSales(request), EFFECT).toBe(7);
});

test('reactivating the suspended agency publishes its listings and lets its users in', async ({
  browser,
  consoleGuard,
  page,
  request,
}) => {
  // The Schwabing listing has a broken image on purpose (seed), shown as placeholder.
  consoleGuard.allow(/404 .*\/demo-media\/photos\/lost-in-the-move\.webp\)$/);
  expect(await publicRentals(request, 'München')).toBe(0);
  await new PortalPage(page).signIn(
    USERS.paula,
    `/portal/admin/agencies/${AGENCIES.alpenblick.agencyId}`,
  );
  const agency = agencyPage(page);
  await expect(agency.state).toHaveText('Suspended');
  await agency.reactivate.click();
  await expect(agency.notice).toHaveText('The agency was reactivated.');

  await expect.poll(() => publicRentals(request, 'München'), EFFECT).toBe(1);
  const search = new SearchPage(page);
  await search.goto({ offerType: 'RENT', city: 'München' });
  await search.expectTitles(['[DEMO] 2-Zimmer-Wohnung in Schwabing']);

  const sepp = await browser.newPage();
  try {
    const portal = new PortalPage(sepp);
    await portal.signIn(USERS.sepp);
    await expect(
      portal.row(portal.table('Listings of your agency'), '[DEMO] 2-Zimmer-Wohnung in Schwabing'),
    ).toBeVisible();
  } finally {
    await sepp.close();
  }
});

test('access mode "API keys required" closes the public API; "Open" opens it again (Req 17.4/17.5)', async ({
  consoleGuard,
  page,
  request,
}) => {
  consoleGuard.allow(/Failed to load resource: .* 401 /);
  await new PortalPage(page).signIn(USERS.paula, '/portal/admin/operations');
  const access = page.getByRole('region', { name: 'Access' });
  const modeForm = access.locator('form', { has: page.getByRole('combobox', { name: 'Mode' }) });
  await modeForm
    .getByRole('combobox', { name: 'Mode' })
    .selectOption({ label: 'API keys required' });
  await modeForm.getByRole('button', { name: 'Save' }).click();
  await expect(access.getByText('Saved.')).toBeVisible();

  await expect.poll(() => publicSales(request), EFFECT).toBe('HTTP 401');
  const response = await request.get('/api/listings?offerType=SALE');
  expect(await response.json()).toEqual({
    errors: [expect.objectContaining({ code: 'API_KEY_MISSING' })],
  });
  // The public SPA has no key: its search fails with a message instead of results.
  const search = new SearchPage(page);
  await search.goto({ offerType: 'SALE' });
  await expect(search.results.getByRole('alert')).toBeVisible();

  await page.goto('/portal/admin/operations');
  await modeForm
    .getByRole('combobox', { name: 'Mode' })
    .selectOption({ label: 'Open (no API key needed)' });
  await modeForm.getByRole('button', { name: 'Save' }).click();
  await expect(access.getByText('Saved.')).toBeVisible();
  await expect.poll(() => publicSales(request), EFFECT).toBe(7);
});

test('a deletion request removes a listing with all versions, everywhere (Req 9.x, 18.4)', async ({
  consoleGuard,
  page,
  request,
}) => {
  consoleGuard.allow(/Failed to load resource: .* 404 /);
  const kiel = (await (await request.get('/api/listings?offerType=RENT&city=Kiel')).json()) as {
    items: { id: string }[];
  };
  const id = kiel.items[0]?.id ?? '';
  expect(id).not.toBe('');

  await new PortalPage(page).signIn(USERS.paula, '/portal/admin/operations');
  const deletion = page.getByRole('region', { name: 'Deletion requests' });
  await deletion.getByRole('combobox', { name: 'Criterion' }).selectOption({ label: 'Listing ID' });
  await deletion.getByRole('textbox', { name: 'Value' }).fill(id);
  await deletion.getByRole('button', { name: 'Request deletion …' }).click();
  const dialog = page.getByRole('dialog', { name: `Delete listings for ${id}?` });
  await expect(dialog).toContainText('Affected listings: 1');
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(deletion).toContainText('The deletion request was created.');

  await expect
    .poll(async () => (await request.get(`/api/listings/${id}`)).status(), EFFECT)
    .toBe(404);
  expect(await publicRentals(request, 'Kiel')).toBe(0);
  // Gone from the portal as well, history included.
  await page.goto(`/portal/listings/${id}`);
  await expect(page.getByRole('heading', { name: 'Listing not available' })).toBeVisible();
});

test('the last platform admin keeps the role; a new platform admin can be added', async ({
  consoleGuard,
  page,
}, testInfo) => {
  consoleGuard.allow(/Failed to load resource: .* 409 /);
  await new PortalPage(page).signIn(USERS.paula, '/portal/admin/operations');
  const admins = page.getByRole('region', { name: 'Platform Admins' });
  const paula = admins
    .getByRole('row')
    .filter({ has: page.getByRole('rowheader', { name: USERS.paula.displayName }) });
  await paula.getByRole('button', { name: 'Revoke role …' }).click();
  await expect(
    page.getByText('The last platform admin cannot be removed or demoted.'),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(paula).toBeVisible();

  const email = `${unique(testInfo, 'admin')}@example.org`;
  await admins.getByRole('textbox', { name: 'E-mail' }).fill(email);
  await admins.getByRole('button', { name: 'Add Platform Admin' }).click();
  await expect(admins).toContainText('The Platform Admin was added.');
  await expect(admins.getByRole('row').filter({ hasText: email })).toBeVisible();
});

test('platform admins (de)activate listings of every agency', async ({ page, request }) => {
  const portal = new PortalPage(page);
  await portal.signIn(USERS.paula, '/portal/admin/listings');
  const table = portal.table('Listings of your agency');
  const search = page.getByRole('searchbox', { name: 'Title contains' });
  const apply = async () => {
    const loaded = page.waitForResponse(
      (r) => new URL(r.url()).pathname === '/management/listings',
    );
    await page.getByRole('button', { name: 'Apply filters' }).click();
    await loaded;
  };

  // A listing of Nordlicht: leaves the public search.
  const mitte = '[DEMO] Helle 3-Zimmer-Altbauwohnung in Berlin-Mitte';
  await search.fill('Berlin-Mitte');
  await apply();
  await portal
    .row(table, mitte)
    .getByRole('button', { name: `Deactivate ${mitte}` })
    .click();
  await expect(portal.row(table, mitte).getByRole('cell').nth(1)).toHaveText('Inactive');
  // Only its neighbour in the same building (another unit) stays public in Berlin.
  expect(await publicSales(request, 'Berlin')).toBe(1);

  // A listing of the (suspended) Alpenblick agency.
  const schwabing = '[DEMO] 2-Zimmer-Wohnung in Schwabing';
  await search.fill('Schwabing');
  await apply();
  const row = portal.row(table, schwabing);
  await expect(row.getByRole('cell').first()).toHaveText(AGENCIES.alpenblick.agencyId);
  await row.getByRole('button', { name: `Deactivate ${schwabing}` }).click();
  await expect(row.getByRole('cell').nth(1)).toHaveText('Inactive');
  await row.getByRole('button', { name: `Activate ${schwabing}` }).click();
  await expect(row.getByRole('cell').nth(1)).toHaveText('Active');

  // And back: Berlin-Mitte is public again.
  await search.fill('Berlin-Mitte');
  await apply();
  await portal
    .row(table, mitte)
    .getByRole('button', { name: `Activate ${mitte}` })
    .click();
  await expect(portal.row(table, mitte).getByRole('cell').nth(1)).toHaveText('Active');
  expect(await publicSales(request, 'Berlin')).toBe(2);
});
