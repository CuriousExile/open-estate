import type { Page } from '@playwright/test';
import { expect, test } from '../../support/fixtures';
import { createListing } from '../../support/listing-form';
import { PortalPage, USERS } from '../../support/portal';
import { unique } from '../../support/unique';

// Audit log of an agency (Req 11.x). Parallel tests add entries all the time, so the tests look
// for specific entries and check the filters' effect on every row, never totals.

function audit(page: Page) {
  const portal = new PortalPage(page);
  const filters = page.getByRole('form', { name: 'Filter audit log' });
  const table = portal.table('Audit log of your agency');
  return {
    filters,
    table,
    rows: table.locator('tbody tr'),
    column: async (index: number) =>
      (await table.locator(`tbody tr > :nth-child(${index})`).allInnerTexts()).map((t) => t.trim()),
    async apply() {
      const loaded = page.waitForResponse(
        (r) => new URL(r.url()).pathname === '/management/audit-log',
      );
      await filters.getByRole('button', { name: 'Apply filters' }).click();
      await loaded;
    },
  };
}

test.beforeEach(async ({ page }) => {
  await new PortalPage(page).signIn(USERS.anna, '/portal/audit');
  await expect(page.getByRole('heading', { level: 1, name: 'Audit log' })).toBeVisible();
});

test('shows who did what, through which channel, with the result', async ({ page }) => {
  const a = audit(page);
  await expect(a.table.getByRole('columnheader')).toHaveText([
    'Time',
    'Actor',
    'Channel',
    'Action',
    'Target',
    'Result',
  ]);
  // Seeded: the revocation of the old export script by Anna in the portal.
  const revoke = a.rows
    .filter({ hasText: 'machine-access.revoke' })
    .filter({ hasText: USERS.anna.displayName });
  await expect(revoke.first()).toContainText('Portal');
  await expect(revoke.first()).toContainText('SUCCESS');
});

test('an action in the portal appears at the top of the log', async ({ page }, testInfo) => {
  const id = await createListing(page, { title: `Audited ${unique(testInfo)}` });
  await page.goto('/portal/audit');
  const a = audit(page);
  const entry = a.rows.filter({ hasText: `listing/${id}` });
  await expect(entry).toHaveCount(1);
  await expect(entry).toContainText('listing.create');
  await expect(entry).toContainText(`User ${USERS.anna.displayName}`);
  await expect(entry).toContainText('Portal');
  await expect(entry).toContainText('SUCCESS');
});

test('filters by action and by actor', async ({ page }) => {
  const a = audit(page);
  await a.filters.getByRole('textbox', { name: 'Action' }).fill('listing.restore');
  await a.apply();
  const actions = await a.column(4);
  expect(actions.length).toBeGreaterThanOrEqual(1);
  for (const action of actions) expect(action).toBe('listing.restore');

  await a.filters.getByRole('textbox', { name: 'Action' }).fill('');
  await a.filters.getByRole('textbox', { name: 'Actor ID' }).fill('user-max-nordlicht');
  await a.apply();
  const actors = await a.column(2);
  expect(actors.length).toBeGreaterThanOrEqual(1);
  for (const actor of actors) expect(actor).toContain(USERS.max.displayName);

  await a.filters.getByRole('button', { name: 'Reset' }).click();
  await expect(a.filters.getByRole('textbox', { name: 'Actor ID' })).toHaveValue('');
});

test('the time range is validated', async ({ page }) => {
  const a = audit(page);
  await a.filters.getByRole('textbox', { name: 'From (UTC)' }).fill('2026-12-31');
  await a.filters.getByRole('textbox', { name: 'To (UTC)' }).fill('2026-01-01');
  await a.filters.getByRole('button', { name: 'Apply filters' }).click();
  await expect(a.filters.getByRole('alert')).toContainText(
    'The start date must not be after the end date.',
  );
});
