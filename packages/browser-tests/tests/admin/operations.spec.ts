import type { Page } from '@playwright/test';
import { expect, test } from '../../support/fixtures';
import { PortalPage, USERS } from '../../support/portal';

// Admin mode → operations (Req 10.x, 17.x), the parts that do not change what other tests see:
// reload, creating an API key (the access mode stays "open"), input validation, the platform
// admins. Deletions, access mode and admin changes are in admin.serial.spec.ts.

function operations(page: Page) {
  return {
    deletion: page.getByRole('region', { name: 'Deletion requests' }),
    keys: page.getByRole('region', { name: 'API keys' }),
    access: page.getByRole('region', { name: 'Access' }),
    reload: page.getByRole('region', { name: 'Reload' }),
    admins: page.getByRole('region', { name: 'Platform Admins' }),
  };
}

test.beforeEach(async ({ page }) => {
  await new PortalPage(page).signIn(USERS.paula, '/portal/admin/operations');
  await expect(page.getByRole('heading', { level: 1, name: 'Operations' })).toBeVisible();
});

test('nothing covers the page after loading: no dialog is open', async ({ page }) => {
  // Regression: the confirmation dialog opened empty and modal on load (safe navigation in the
  // template yields null, which the dialog took for a confirmation), blocking every control.
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(
    operations(page).reload.getByRole('button', { name: 'Reload configuration' }),
  ).toBeEnabled();
});

test('reload restarts the functions and reports each one', async ({ page }) => {
  const o = operations(page);
  await o.reload.getByRole('button', { name: 'Reload configuration' }).click();
  const table = o.reload.getByRole('table');
  await expect(table.getByRole('columnheader')).toHaveText(['Function', 'Result']);
  await expect(table.locator('tbody tr')).toHaveCount(3);
  for (const result of await table.locator('tbody tr > td').allInnerTexts()) {
    expect(result).toMatch(/^Restarted \(configuration version .+\)$/);
  }
});

test('an API key is shown once after creation', async ({ page }) => {
  const o = operations(page);
  const form = o.keys.locator('form', { has: page.getByRole('button', { name: 'Create key' }) });
  await form.getByRole('textbox', { name: 'Requests' }).fill('100');
  await form.getByRole('textbox', { name: 'Window (seconds)' }).fill('60');
  await form.getByRole('button', { name: 'Create key' }).click();
  const created = o.keys.getByRole('status').filter({ hasText: 'Copy the key now' });
  await expect(created).toContainText('Copy the key now — it is shown only once.');
  await expect(created).toContainText('Key ID');
  await created.getByRole('button', { name: 'Hide key' }).click();
  await expect(created).toHaveCount(0);
});

test('numbers and e-mail addresses are validated before anything is sent', async ({ page }) => {
  const o = operations(page);
  await o.access.getByRole('textbox', { name: 'Requests' }).fill('many');
  await o.access.getByRole('button', { name: 'Save' }).first().click();
  await expect(o.access.getByRole('alert').first()).toContainText(
    'Please enter a whole number from',
  );

  await o.admins.getByRole('textbox', { name: 'E-mail' }).fill('not-an-email');
  await o.admins.getByRole('button', { name: 'Add Platform Admin' }).click();
  await expect(o.admins.getByRole('alert').first()).toContainText(
    'Please enter a valid e-mail address.',
  );
});

test('the platform admins', async ({ page }) => {
  const o = operations(page);
  const row = o.admins
    .getByRole('row')
    .filter({ has: page.getByRole('rowheader', { name: USERS.paula.displayName }) });
  await expect(row).toContainText(USERS.paula.email);
  await expect(row.getByRole('button', { name: 'Revoke role …' })).toBeVisible();
});

test('a deletion asks for confirmation with the effects; "Cancel" deletes nothing', async ({
  page,
  request,
}) => {
  const o = operations(page);
  // A public listing: its id from the Search API.
  const search = (await (
    await request.get('/api/listings?offerType=SALE&city=Kiel&lang=en')
  ).json()) as {
    items: { id: string }[];
  };
  const rent = (await (
    await request.get('/api/listings?offerType=RENT&city=Kiel&lang=en')
  ).json()) as {
    items: { id: string }[];
  };
  const id = [...search.items, ...rent.items][0]?.id ?? '';
  expect(id).not.toBe('');

  await o.deletion
    .getByRole('combobox', { name: 'Criterion' })
    .selectOption({ label: 'Listing ID' });
  await o.deletion.getByRole('textbox', { name: 'Value' }).fill(id);
  await o.deletion.getByRole('button', { name: 'Request deletion …' }).click();
  const dialog = page.getByRole('dialog', { name: `Delete listings for ${id}?` });
  await expect(dialog).toContainText('Affected listings: 1');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  expect((await request.get(`/api/listings/${id}`)).status()).toBe(200);
});
