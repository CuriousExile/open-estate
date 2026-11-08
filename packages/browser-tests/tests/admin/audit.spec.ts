import type { Page } from '@playwright/test';
import { expect, test } from '../../support/fixtures';
import { AGENCIES, PortalPage, USERS } from '../../support/portal';

// Admin mode → platform audit log (Req 11.4): entries of all agencies with filters. Other tests
// write entries concurrently: specific entries and the filters' effect are checked, not totals.

function platformAudit(page: Page) {
  const table = new PortalPage(page).table('Platform audit log');
  return {
    table,
    rows: table.locator('tbody tr'),
    column: async (index: number) =>
      (await table.locator(`tbody tr > :nth-child(${index})`).allInnerTexts()).map((t) => t.trim()),
    filter: (name: string) => page.getByRole('textbox', { name, exact: true }),
    async apply() {
      const loaded = page.waitForResponse(
        (r) => new URL(r.url()).pathname === '/management/audit-log',
      );
      await page.getByRole('button', { name: 'Apply filters' }).click();
      await loaded;
    },
  };
}

test.beforeEach(async ({ page }) => {
  await new PortalPage(page).signIn(USERS.paula, '/portal/admin/audit');
  await expect(page.getByRole('heading', { level: 1, name: 'Platform audit log' })).toBeVisible();
});

test('contains the suspension of Alpenblick by the platform admin', async ({ page }) => {
  const a = platformAudit(page);
  await expect(a.table.getByRole('columnheader')).toHaveText([
    'Time',
    'Actor',
    'Channel',
    'Action',
    'Target',
    'Agency',
    'Result',
  ]);
  await a.filter('Agency').fill(AGENCIES.alpenblick.agencyId);
  await a.apply();
  const suspension = a.rows.filter({ hasText: `agency/${AGENCIES.alpenblick.agencyId}` }).filter({
    hasText: `User ${USERS.paula.displayName}`,
  });
  await expect(suspension.first()).toContainText('Administration');
  await expect(suspension.first()).toContainText('SUCCESS');
  for (const agency of await a.column(6)) expect(agency).toBe(AGENCIES.alpenblick.agencyId);
});

test('filters by action', async ({ page }) => {
  const a = platformAudit(page);
  await a.filter('Action').fill('machine-access.create');
  await a.apply();
  const actions = await a.column(4);
  expect(actions.length).toBeGreaterThanOrEqual(2); // both seeded accesses
  for (const action of actions) expect(action).toBe('machine-access.create');
});

test('a refused access is logged with the user who tried (Req 2.8)', async ({ browser, page }) => {
  // Sepp's agency is suspended: his attempt is refused with 403 AGENCY_SUSPENDED.
  const other = await browser.newPage();
  try {
    const portal = new PortalPage(other);
    await other.goto('/portal');
    await other.waitForURL('**/oidc/authorize**');
    await other
      .getByRole('button', { name: new RegExp(USERS.sepp.email.replace(/\./g, '\\.')) })
      .click();
    await expect(portal.notice).toBeVisible();
  } finally {
    await other.close();
  }
  const a = platformAudit(page);
  await a.filter('Action').fill('GET /me');
  await a.apply();
  const refused = a.rows.filter({ hasText: 'AGENCY_SUSPENDED' }).first();
  await expect(refused).toBeVisible();
  // The actor is known (a valid token of Sepp), so the entry must name him and his agency.
  await expect(refused).toContainText(USERS.sepp.displayName);
  await expect(refused).toContainText(AGENCIES.alpenblick.agencyId);
});
