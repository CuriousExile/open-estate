import type { Page } from '@playwright/test';
import { expect, test } from '../../support/fixtures';
import { AGENCIES, PortalPage, USERS } from '../../support/portal';

// Admin mode → platform monitoring (Req 14.x): alarms and endpoint figures (synthetic in the local
// demo), agency activity, version history size, connector runs across agencies.

function monitoring(page: Page) {
  return {
    period: page.getByRole('combobox', { name: 'Period' }),
    alarms: page.getByRole('region', { name: 'Alarms' }),
    endpoints: page.getByRole('region', { name: 'Endpoints' }),
    activity: page.getByRole('region', { name: 'Agency activity' }),
    history: page.getByRole('region', { name: 'Version history size' }),
    runs: page.getByRole('region', { name: 'Connector runs' }),
  };
}

test.beforeEach(async ({ page }) => {
  await new PortalPage(page).signIn(USERS.paula, '/portal/admin/monitoring');
  await expect(page.getByRole('heading', { level: 1, name: 'Platform monitoring' })).toBeVisible();
});

test('the period selector shows the period the figures are for', async ({ page }) => {
  const m = monitoring(page);
  // Default: the last 24 hours. The figures are requested for that period …
  const platform = page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/management/monitoring/platform',
  );
  await page.reload();
  const query = new URL((await platform).url()).searchParams;
  const hours =
    (Date.parse(query.get('to') ?? '') - Date.parse(query.get('from') ?? '')) / 3_600_000;
  expect(hours).toBeCloseTo(24, 1);
  // … and the selector must say so.
  await expect(m.period).toHaveValue('24h');
  await expect(m.period.locator('option:checked')).toHaveText('Last 24 hours');
});

test('alarms and endpoints', async ({ page }) => {
  const m = monitoring(page);
  await expect(m.alarms.getByRole('status')).toHaveText(/Alarms in state Alarm: \d+/);
  await expect(m.alarms.getByRole('rowheader', { name: /Connector-failures/ })).toBeVisible();
  for (const endpoint of ['search', 'detail', 'meta']) {
    await expect(m.endpoints.getByRole('rowheader', { name: endpoint, exact: true })).toBeVisible();
  }
  await expect(m.endpoints.getByRole('columnheader')).toContainText([
    'Interface',
    'Endpoint',
    'p95 latency',
    'Requests',
  ]);
});

for (const [key, label] of [
  ['24h', 'Last 24 hours'],
  ['7d', 'Last 7 days'],
  ['30d', 'Last 30 days'],
] as const) {
  test(`agency activity for "${label}"`, async ({ page }) => {
    const m = monitoring(page);
    if (key !== '24h') await m.period.selectOption(key);
    await expect(m.period).toHaveValue(key);
    // Changes per channel per agency, not an error.
    await expect(m.activity.getByRole('alert')).toHaveCount(0);
    await expect(m.activity.getByRole('table')).toBeVisible();
    await expect(
      m.activity.getByRole('rowheader', { name: AGENCIES.nordlicht.agencyId }),
    ).toBeVisible();
  });
}

test('version history size per agency and in total', async ({ page }) => {
  const m = monitoring(page);
  await expect(m.history.getByRole('columnheader')).toHaveText(['Agency', 'Versions', 'Storage']);
  await expect(m.history.getByRole('rowheader').first()).toBeVisible();
});

test('connector runs across agencies, filtered by result', async ({ page }) => {
  const m = monitoring(page);
  const rows = m.runs.locator('tbody tr:has(th)');
  await expect(rows).toHaveCount(4);
  await m.runs.getByRole('combobox', { name: 'Result' }).selectOption('FAILURE');
  await m.runs.getByRole('button', { name: 'Show' }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('Error');
});
