import type { APIRequestContext, Page } from '@playwright/test';
import { expect, test } from '../../support/fixtures';
import { PortalPage, USERS } from '../../support/portal';
import { unique } from '../../support/unique';

// Machine accesses of an agency (Req 3.x): list, create with a one-time secret, use the secret
// against the Management API, revoke. Tests revoke only accesses they created themselves.

function machineAccess(page: Page) {
  const portal = new PortalPage(page);
  const create = page.getByRole('form', { name: 'Create machine access' });
  const table = portal.table('Machine accesses of your agency');
  return {
    portal,
    create,
    table,
    label: create.getByRole('textbox', { name: 'Name' }),
    expires: create.getByRole('textbox', { name: 'Expires' }),
    permission: (code: string) => create.getByRole('checkbox', { name: new RegExp(`${code}$`) }),
    submit: create.getByRole('button', { name: 'Create machine access' }),
    secretRegion: (label: string) => page.getByRole('region', { name: `Secret of ${label}` }),
    row: (label: string) => portal.row(table, new RegExp(`^${label} `)),
  };
}

/** Calls the Management API with a machine-access secret (through the SPA origin). */
function asMachine(request: APIRequestContext, secret: string) {
  const headers = { Authorization: `Bearer ${secret}` };
  return {
    listListings: () => request.get('/management/listings', { headers }),
    createListing: () =>
      request.post('/management/listings', {
        headers,
        data: {
          status: 'INACTIVE',
          content: {
            originalLocale: 'en',
            title: 'Created by a machine',
            description: '',
            translations: [],
            offers: [{ offerType: 'SALE', price: '100000.00', currency: 'EUR' }],
            listingType: 'apartment_unit',
            rooms: 2,
            area: '50',
            address: { city: 'Berlin', postalCode: '10115', country: 'DE' },
            media: [],
            tours: [],
          },
        },
      }),
  };
}

test.beforeEach(async ({ page }) => {
  await new PortalPage(page).signIn(USERS.anna, '/portal/machine-access');
});

test('lists the seeded accesses: the CRM sync is active, the old script revoked', async ({
  page,
}) => {
  const m = machineAccess(page);
  const crm = m.row('CRM-Sync \\(Demo\\)');
  await expect(crm.getByRole('cell').first()).toHaveText('Active');
  for (const permission of [
    'Read listings',
    'Create and edit listings',
    'Activate and deactivate listings',
    'Read monitoring',
  ]) {
    await expect(crm).toContainText(permission);
  }
  await expect(crm.getByRole('button', { name: 'Revoke CRM-Sync (Demo)' })).toBeVisible();
  const legacy = m.row('Altes Export-Skript');
  await expect(legacy.getByRole('cell').first()).toHaveText('Revoked');
  await expect(legacy.getByRole('button', { name: /Revoke/ })).toHaveCount(0);
  // Only permissions a machine access may hold are offered (no member or access management).
  await expect(m.create.getByRole('checkbox')).toHaveCount(6);
  await expect(m.create).not.toContainText('member:manage');
});

test('invalid input is named: name, permissions and a past expiry', async ({ page }) => {
  const m = machineAccess(page);
  await m.expires.fill('2020-01-01T10:00');
  await m.submit.click();
  const errors = m.create.getByRole('alert');
  await expect(errors).toContainText('Enter 1 to');
  await expect(errors).toContainText(
    'Choose at least one permission that can be granted to a machine access.',
  );
  await expect(errors).toContainText(
    'Enter a date and time in the future, or leave the field empty.',
  );
  await expect(m.label).toHaveAttribute('aria-invalid', 'true');
});

test('create → the secret is shown once → it works with exactly its permissions → revoke', async ({
  context,
  consoleGuard,
  page,
  request,
}, testInfo) => {
  consoleGuard.allow(/Failed to load resource: .* 401 /);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const m = machineAccess(page);
  const label = unique(testInfo, 'Browser test access');
  await m.label.fill(label);
  await m.permission('listing:read').check();
  await m.submit.click();

  // The secret: shown once, copyable.
  const secretRegion = m.secretRegion(label);
  await expect(secretRegion).toContainText(
    'It is shown only this once and cannot be displayed again.',
  );
  const secret = await secretRegion.getByRole('textbox', { name: 'Secret' }).inputValue();
  expect(secret).toMatch(/^oem_\S{20,}$/);
  await secretRegion.getByRole('button', { name: 'Copy' }).click();
  await expect(secretRegion.getByRole('status')).toHaveText(
    'The secret was copied to the clipboard.',
  );
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(secret);
  await secretRegion.getByRole('button', { name: 'I have stored the secret' }).click();
  await expect(secretRegion).toHaveCount(0);
  await page.reload();
  await expect(m.row(label).getByRole('cell').first()).toHaveText('Active');
  await expect(page.getByRole('textbox', { name: 'Secret' })).toHaveCount(0);

  // The secret authenticates against the Management API — for reading only.
  const machine = asMachine(request, secret);
  const list = await machine.listListings();
  expect(list.status()).toBe(200);
  expect(((await list.json()) as { items: unknown[] }).items.length).toBeGreaterThanOrEqual(14);
  const write = await machine.createListing();
  expect(write.status()).toBe(403);

  // Revoke: confirmation, then the secret stops working (local demo: access cache 5 s).
  await m
    .row(label)
    .getByRole('button', { name: `Revoke ${label}` })
    .click();
  const dialog = page.getByRole('dialog', { name: `Revoke ${label}?` });
  await expect(dialog).toContainText(`Systems using ${label} lose access within 60 seconds.`);
  await dialog.getByRole('button', { name: `Revoke ${label}` }).click();
  await expect(page.getByRole('status').filter({ hasText: 'was revoked' })).toHaveText(
    'The machine access was revoked. Further requests with it are rejected within 60 seconds.',
  );
  await expect(m.row(label).getByRole('cell').first()).toHaveText('Revoked');
  await expect
    .poll(async () => (await machine.listListings()).status(), { timeout: 15_000 })
    .toBe(401);
});

test('a revoke can be cancelled', async ({ page }) => {
  const m = machineAccess(page);
  await m
    .row('CRM-Sync \\(Demo\\)')
    .getByRole('button', { name: 'Revoke CRM-Sync (Demo)' })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Revoke CRM-Sync (Demo)?' });
  await expect(dialog).toContainText('This cannot be undone.');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(m.row('CRM-Sync \\(Demo\\)').getByRole('cell').first()).toHaveText('Active');
});
