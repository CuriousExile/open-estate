import type { Page } from '@playwright/test';
import { expect, test } from '../../support/fixtures';
import { AGENCIES, PortalPage, USERS } from '../../support/portal';
import { Workspace } from '../../support/workspace';

// Admin mode → all listings (Req 10.4): every agency's listings with an agency column and filter;
// the workspace of a listing of the suspended agency.

const SCHWABING = '[DEMO] 2-Zimmer-Wohnung in Schwabing';

function allListings(page: Page) {
  const portal = new PortalPage(page);
  const table = portal.table('Listings of your agency');
  const filters = page.getByRole('form', { name: 'Filter listings' });
  return {
    table,
    filters,
    row: (title: string) => portal.row(table, title),
    agencies: async () =>
      (await table.locator('tbody tr > td:nth-of-type(1)').allInnerTexts()).map((t) => t.trim()),
    async apply() {
      const loaded = page.waitForResponse(
        (r) => new URL(r.url()).pathname === '/management/listings',
      );
      await filters.getByRole('button', { name: 'Apply filters' }).click();
      await loaded;
    },
  };
}

test.beforeEach(async ({ page }) => {
  await new PortalPage(page).signIn(USERS.paula, '/portal/admin/listings');
});

test('lists the listings of every agency, with the agency', async ({ page }) => {
  const l = allListings(page);
  await expect(l.table.getByRole('columnheader', { name: 'Agency' })).toBeVisible();
  // More than one page (20 per page) with the listings other tests create: narrow by title.
  await l.filters.getByRole('searchbox', { name: 'Title contains' }).fill('Zimmer');
  await l.apply();
  await expect(l.row(SCHWABING).getByRole('cell').first()).toHaveText(AGENCIES.alpenblick.agencyId);
  await expect(
    l.row('[DEMO] Helle 3-Zimmer-Altbauwohnung in Berlin-Mitte').getByRole('cell').first(),
  ).toHaveText(AGENCIES.nordlicht.agencyId);
  // The agency cell links to the agency.
  await l.row(SCHWABING).getByRole('link', { name: AGENCIES.alpenblick.agencyId }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: AGENCIES.alpenblick.displayName }),
  ).toBeVisible();
});

test('the agency filter', async ({ page }) => {
  const l = allListings(page);
  await l.filters.getByRole('textbox', { name: 'Agency' }).fill(AGENCIES.alpenblick.agencyId);
  await l.apply();
  const agencies = await l.agencies();
  expect(agencies).toEqual([
    AGENCIES.alpenblick.agencyId,
    AGENCIES.alpenblick.agencyId,
    AGENCIES.alpenblick.agencyId,
  ]);
});

test('a listing of the suspended agency: active, but not public; the preview still works', async ({
  page,
  request,
}) => {
  const l = allListings(page);
  await l.filters.getByRole('textbox', { name: 'Agency' }).fill(AGENCIES.alpenblick.agencyId);
  await l.apply();
  await l.row(SCHWABING).getByRole('link', { name: SCHWABING, exact: true }).click();
  const workspace = new Workspace(page);
  await expect(workspace.meta('Status')).toHaveText('Active');
  await expect(workspace.meta('Source')).toHaveText(`agency:${AGENCIES.alpenblick.agencyId}`);
  const id = new URL(page.url()).pathname.split('/').pop() ?? '';
  expect((await request.get(`/api/listings/${id}`)).status()).toBe(404);
  // Its one image is a broken link in the demo: the preview shows the placeholder.
  await expect(
    workspace.panel.getByRole('img', { name: 'Image 1 of 1 could not be loaded' }),
  ).toBeVisible();
});
