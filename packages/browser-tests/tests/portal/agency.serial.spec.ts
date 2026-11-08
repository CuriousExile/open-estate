import type { Page } from '@playwright/test';
import { resetDemo } from '../../support/demo-server';
import { expect, test } from '../../support/fixtures';
import { createListing } from '../../support/listing-form';
import { PortalPage, USERS } from '../../support/portal';
import { SearchPage } from '../../support/search-page';
import { unique } from '../../support/unique';
import { Workspace } from '../../support/workspace';

// Agency portal actions that change seeded or public state (project `serial`: one at a time,
// after the parallel projects, each test on a freshly reset demo).

test.beforeEach(async ({ request }) => {
  await resetDemo(request);
});

function teamRow(page: Page, name: string) {
  const portal = new PortalPage(page);
  return portal.row(portal.table('Members of your agency'), name);
}

test('a listing created as active is public at once, with its own page as source (Req 6.5)', async ({
  page,
  request,
}, testInfo) => {
  await new PortalPage(page).signIn(USERS.anna);
  const title = `Published ${unique(testInfo)}`;
  const city = `Neustadt ${unique(testInfo, 'c')}`;
  const id = await createListing(page, { title, city, price: '275000', status: 'Active' });
  await expect(new Workspace(page).meta('Status')).toHaveText('Active');

  // The public search finds it right away (locally the projection is immediate).
  const search = new SearchPage(page);
  await search.goto({ offerType: 'SALE', city });
  await search.expectTitles([title]);
  await search.openListing(title);
  // Without a source URL, "View original listing" is the public detail page of the listing.
  const origin = new URL(page.url()).origin;
  await expect(search.detail.getByRole('link', { name: /View original listing/ })).toHaveAttribute(
    'href',
    `${origin}/listings/${id}`,
  );
  expect((await request.get(`/api/listings/${id}`)).status()).toBe(200);
});

test('restoring a version makes it the current, public content (Req 8.x)', async ({ page }) => {
  await new PortalPage(page).signIn(USERS.anna);
  await page
    .getByRole('link', { name: '[DEMO] Helle 3-Zimmer-Altbauwohnung in Berlin-Mitte', exact: true })
    .click();
  const workspace = new Workspace(page);
  await workspace.tab('History').click();
  await workspace.version(1).getByRole('button', { name: 'Restore version 1' }).click();
  const dialog = page.getByRole('dialog', { name: 'Restore version 1?' });
  await dialog.getByRole('button', { name: 'Restore version 1' }).click();

  await expect(page.getByRole('status').filter({ hasText: 'was restored' })).toHaveText(
    'The version was restored. The listing is now at version 5.',
  );
  await expect(workspace.meta('Version')).toHaveText('5');
  await workspace.tab('History').click();
  await expect(workspace.version(5)).toContainText('Restored from version 1');

  // The public search shows the restored price (489,000 € instead of 469,000 €).
  const search = new SearchPage(page);
  await search.goto({ offerType: 'SALE', city: 'Berlin' });
  await expect(search.card('[DEMO] Bright 3-room period apartment in Berlin-Mitte')).toContainText(
    '€489,000',
  );
});

test('a new role applies to the member’s next sign-in (Req 1.6)', async ({ browser, page }) => {
  await new PortalPage(page).signIn(USERS.anna, '/portal/team');
  const row = teamRow(page, USERS.max.displayName);
  await row
    .getByRole('combobox', { name: `Role of ${USERS.max.displayName}` })
    .selectOption('AGENCY_ADMIN');
  await row.getByRole('button', { name: 'Save role' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'was changed' })).toHaveText(
    `The role of ${USERS.max.displayName} was changed. It applies to all further requests within 60 seconds.`,
  );

  const other = await browser.newPage();
  try {
    const portal = new PortalPage(other);
    await portal.signIn(USERS.max);
    // Locally the access cache keeps roles 5 s (60 s in AWS).
    await expect
      .poll(
        async () => {
          await other.reload();
          await expect(portal.nav).toBeVisible();
          return portal.navNames();
        },
        { timeout: 20_000, intervals: [1_000] },
      )
      .toContain('Team');
  } finally {
    await other.close();
  }
});

test('a removed member loses access to the portal', async ({ browser, consoleGuard, page }) => {
  consoleGuard.allow(/Failed to load resource: .* 40[13] /);
  await new PortalPage(page).signIn(USERS.anna, '/portal/team');
  await teamRow(page, USERS.max.displayName)
    .getByRole('button', { name: /^Remove/ })
    .click();
  const dialog = page.getByRole('dialog', { name: `Remove ${USERS.max.displayName}?` });
  await dialog.getByRole('button', { name: `Remove ${USERS.max.displayName}` }).click();
  await expect(page.getByRole('status').filter({ hasText: 'was removed' })).toHaveText(
    `${USERS.max.displayName} was removed from the agency.`,
  );
  await expect(teamRow(page, USERS.max.displayName)).toHaveCount(0);

  const other = await browser.newPage();
  try {
    await other.goto('/portal');
    await other.waitForURL('**/oidc/authorize**');
    // Without membership the local login page no longer offers Max.
    await expect(
      other.getByRole('button', { name: new RegExp(USERS.max.email.replace(/\./g, '\\.')) }),
    ).toHaveCount(0);
  } finally {
    await other.close();
  }
});

test('the last agency admin cannot demote themselves', async ({ consoleGuard, page }) => {
  consoleGuard.allow(/Failed to load resource: .* 409 /);
  await new PortalPage(page).signIn(USERS.anna, '/portal/team');
  const row = teamRow(page, USERS.anna.displayName);
  await row
    .getByRole('combobox', { name: `Role of ${USERS.anna.displayName}` })
    .selectOption('AGENCY_MEMBER');
  await row.getByRole('button', { name: 'Save role' }).click();
  await expect(row.getByRole('alert')).toHaveText(
    'The last agency admin cannot be removed or demoted.',
  );
  await page.reload();
  await expect(
    teamRow(page, USERS.anna.displayName).getByRole('combobox', {
      name: `Role of ${USERS.anna.displayName}`,
    }),
  ).toHaveValue('AGENCY_ADMIN');
});

test('the agency deactivates a listing in its list and activates it again in the workspace (Req 6.2)', async ({
  browser,
  page,
  request,
}) => {
  const KIEL = '[DEMO] Gemütliche 2-Zimmer-Wohnung nahe der Kiellinie';
  const kielPublic = async () =>
    (
      (await (await request.get('/api/listings?offerType=RENT&city=Kiel')).json()) as {
        items: unknown[];
      }
    ).items.length;
  expect(await kielPublic()).toBe(1);

  // The agency admin, in the listing overview.
  const portal = new PortalPage(page);
  await portal.signIn(USERS.anna);
  const table = portal.table('Listings of your agency');
  const row = portal.row(table, KIEL);
  await row.getByRole('button', { name: `Deactivate ${KIEL}` }).click();
  await expect(page.getByRole('status').filter({ hasText: 'is inactive now' })).toHaveText(
    `${KIEL} is inactive now and no longer shown in the search.`,
  );
  await expect(row.getByRole('cell').first()).toHaveText('Inactive');
  await expect(row.getByRole('button', { name: `Activate ${KIEL}` })).toBeVisible();
  expect(await kielPublic()).toBe(0);
  // Not public: the public detail page answers "not found".
  const id = ((await row.getByRole('link', { name: KIEL, exact: true }).getAttribute('href')) ?? '')
    .split('/')
    .pop();
  expect((await request.get(`/api/listings/${id}`)).status()).toBe(404);

  // An agency member activates it again in the workspace.
  const other = await browser.newPage();
  try {
    await new PortalPage(other).signIn(USERS.max, `/portal/listings/${id}`);
    const workspace = new Workspace(other);
    await expect(workspace.meta('Status')).toHaveText('Inactive');
    const version = Number(await workspace.meta('Version').innerText());
    await other.getByRole('button', { name: 'Activate listing' }).click();
    await expect(other.getByRole('status').filter({ hasText: 'was activated' })).toHaveText(
      `The listing was activated and is shown in the search. It is now at version ${version + 1}.`,
    );
    await expect(workspace.meta('Status')).toHaveText('Active');
    await expect(other.getByRole('button', { name: 'Deactivate listing' })).toBeVisible();
    await workspace.tab('History').click();
    await expect(workspace.version(version + 1)).toContainText('Status changed');
    await expect(workspace.version(version)).toContainText('Status changed');
  } finally {
    await other.close();
  }
  expect(await kielPublic()).toBe(1);
});
