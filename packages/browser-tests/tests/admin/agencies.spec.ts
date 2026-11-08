import type { Page } from '@playwright/test';
import { expect, test } from '../../support/fixtures';
import { AGENCIES, PortalPage, USERS } from '../../support/portal';
import { unique } from '../../support/unique';

// Admin mode → agencies (Req 10.x): overview with state filter, agency detail with figures and
// links, suspension preview (cancelled), creating and renaming an own agency. Suspending for real
// is in admin.serial.spec.ts. Parallel tests add members and inactive listings to Nordlicht, so
// those counts are checked as lower bounds.

function agencies(page: Page) {
  const portal = new PortalPage(page);
  const table = portal.table('Agencies');
  return {
    portal,
    table,
    row: (name: string) => portal.row(table, name),
    cell: (name: string, column: number) => portal.row(table, name).getByRole('cell').nth(column),
    stateFilter: page.getByRole('combobox', { name: 'State' }),
  };
}

test.beforeEach(async ({ page }) => {
  await new PortalPage(page).signIn(USERS.paula, '/portal/admin');
  await expect(page).toHaveURL(/\/portal\/admin\/agencies$/);
});

test('admin areas: agencies, all listings, monitoring, operations, audit log', async ({ page }) => {
  const areas = page.getByRole('navigation', { name: 'Admin areas' }).getByRole('link');
  await expect(areas).toHaveText([
    'Agencies',
    'All listings',
    'Duplicates across agencies',
    'Platform monitoring',
    'Operations',
    'Platform audit log',
  ]);
  await expect(areas.filter({ hasText: /^Agencies$/ })).toHaveAttribute('aria-current', 'page');
});

test('the overview shows state, users and listings per agency', async ({ page }) => {
  const a = agencies(page);
  await expect(a.cell(AGENCIES.nordlicht.displayName, 0)).toHaveText('Active');
  expect(
    Number(await a.cell(AGENCIES.nordlicht.displayName, 1).innerText()),
  ).toBeGreaterThanOrEqual(2);
  await expect(a.cell(AGENCIES.nordlicht.displayName, 2)).toHaveText('12'); // active listings
  await expect(a.cell(AGENCIES.alpenblick.displayName, 0)).toHaveText('Suspended');
  await expect(a.cell(AGENCIES.alpenblick.displayName, 1)).toHaveText('1');
  // Its listings stay ACTIVE; the suspension alone keeps them out of the public search.
  await expect(a.cell(AGENCIES.alpenblick.displayName, 2)).toHaveText('4');
  await expect(a.cell(AGENCIES.alpenblick.displayName, 3)).toHaveText('0');
});

test('the state filter', async ({ page }) => {
  const a = agencies(page);
  await a.stateFilter.selectOption({ label: 'Suspended' });
  await expect(a.row(AGENCIES.alpenblick.displayName)).toBeVisible();
  await expect(a.row(AGENCIES.nordlicht.displayName)).toHaveCount(0);
  await a.stateFilter.selectOption({ label: 'Active' });
  await expect(a.row(AGENCIES.nordlicht.displayName)).toBeVisible();
  await expect(a.row(AGENCIES.alpenblick.displayName)).toHaveCount(0);
});

test('the agency detail: id, figures and links to its listings and audit entries', async ({
  page,
}) => {
  await agencies(page).row(AGENCIES.nordlicht.displayName).getByRole('link').click();
  await expect(
    page.getByRole('heading', { level: 1, name: AGENCIES.nordlicht.displayName }),
  ).toBeVisible();
  await expect(page.getByRole('region', { name: AGENCIES.nordlicht.displayName })).toContainText(
    AGENCIES.nordlicht.agencyId,
  );
  const figures = page.getByRole('region', { name: 'Figures (last 30 days)' });
  await expect(figures).toContainText('Listings by status');
  await expect(figures).toContainText('Changes by channel (last 30 days)');

  await page
    .getByRole('link', { name: 'Agency’s listings' })
    .or(page.getByRole('link', { name: "Agency's listings" }))
    .click();
  await expect(page).toHaveURL(
    new RegExp(`/portal/admin/listings\\?agencyId=${AGENCIES.nordlicht.agencyId}$`),
  );
  const agencyColumn = await page
    .getByRole('table', { name: 'Listings of your agency' })
    .locator('tbody tr > td:nth-of-type(1)')
    .allInnerTexts();
  expect(agencyColumn.length).toBeGreaterThanOrEqual(14);
  for (const agency of agencyColumn) expect(agency.trim()).toBe(AGENCIES.nordlicht.agencyId);

  await page.goBack();
  await page.getByRole('link', { name: /Agency.s audit entries/ }).click();
  await expect(page).toHaveURL(
    new RegExp(`/portal/admin/audit\\?agencyId=${AGENCIES.nordlicht.agencyId}$`),
  );
  await expect(page.getByRole('textbox', { name: 'Agency' })).toHaveValue(
    AGENCIES.nordlicht.agencyId,
  );
});

test('suspending asks for confirmation with the effects (dry run); "Cancel" changes nothing', async ({
  page,
}) => {
  await page.goto(`/portal/admin/agencies/${AGENCIES.nordlicht.agencyId}`);
  await page.getByRole('button', { name: 'Suspend agency …' }).click();
  const dialog = page.getByRole('dialog', {
    name: `Suspend the agency ${AGENCIES.nordlicht.displayName}?`,
  });
  await expect(dialog).toBeVisible();
  const listings = Number(/Affected listings: (\d+)/.exec(await dialog.innerText())?.[1]);
  const users = Number(/Affected users: (\d+)/.exec(await dialog.innerText())?.[1]);
  expect(listings).toBeGreaterThanOrEqual(14);
  expect(users).toBeGreaterThanOrEqual(2);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('region', { name: AGENCIES.nordlicht.displayName })).toContainText(
    'Active',
  );
  await expect(page.getByRole('button', { name: 'Suspend agency …' })).toBeVisible();
});

test('creating and renaming an agency', async ({ page }, testInfo) => {
  const name = unique(testInfo, 'Browser Test Agency');
  const create = page.getByRole('region', { name: 'Create agency' });
  await create.getByRole('textbox', { name: 'Display name' }).fill(name);
  await create.getByRole('button', { name: 'Create' }).click();

  // The new agency opens at once: active, no listings yet.
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
  await expect(page.getByRole('region', { name })).toContainText('Active');
  await page.getByRole('link', { name: 'Back to the agencies' }).click();
  const a = agencies(page);
  await expect(a.cell(name, 0)).toHaveText('Active');
  await expect(a.cell(name, 1)).toHaveText('0');

  await a.row(name).getByRole('link', { name }).click();
  const manage = page.getByRole('region', { name: 'Manage agency' });
  await manage.getByRole('textbox', { name: 'Display name' }).fill(`${name} (renamed)`);
  await manage.getByRole('button', { name: 'Rename' }).click();
  await expect(manage.getByRole('status')).toHaveText('The agency was renamed.');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`${name} (renamed)`);
});

test('an agency needs a name', async ({ page }) => {
  const create = page.getByRole('region', { name: 'Create agency' });
  await create.getByRole('button', { name: 'Create' }).click();
  await expect(create.getByRole('alert')).toContainText('Please enter 1 to');
});
