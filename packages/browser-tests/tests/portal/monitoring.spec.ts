import type { Page } from '@playwright/test';
import { expect, test } from '../../support/fixtures';
import { PortalPage, USERS } from '../../support/portal';

// Agency monitoring (Req 13.x): overview, connector runs with rejections, usage with period and
// chart tables. Read-only. Parallel portal tests create inactive listings, so only counts they
// cannot change are asserted exactly.

const RUN_COLUMNS = ['Started', 'Ended', 'Result', 'Created', 'Updated', 'Unchanged', 'Rejected'];

function monitoring(page: Page) {
  const overview = page.getByRole('region', { name: 'Overview' });
  const runs = page.getByRole('region', { name: 'Connector runs' });
  const usage = page.getByRole('region', { name: 'Usage' });
  return {
    overview,
    runs,
    usage,
    /** Value of a `<dt>`/`<dd>` pair inside a figure group ("Listings by status" …). */
    figure: (group: string, term: string) =>
      overview
        .locator('.figures > div', { has: page.getByRole('heading', { level: 3, name: group }) })
        .getByRole('term')
        .filter({ hasText: new RegExp(`^${term}$`) })
        .locator('xpath=following-sibling::dd[1]'),
    runRows: runs.locator('table > tbody > tr:has(th)'),
    problemsOnly: runs.getByRole('checkbox', { name: 'Only runs with errors or rejections' }),
  };
}

test.beforeEach(async ({ page }) => {
  await new PortalPage(page).signIn(USERS.anna, '/portal/monitoring');
  await expect(page.getByRole('heading', { level: 1, name: 'Monitoring' })).toBeVisible();
});

test('overview: listings by status and changes by channel', async ({ page }) => {
  const m = monitoring(page);
  // No parallel test publishes a listing: 12 active (the 3 seeded drafts, the flagged repost of
  // Berlin-Mitte and newly created listings are inactive).
  await expect(m.figure('Listings by status', 'Active')).toHaveText('12');
  const inactive = Number(await m.figure('Listings by status', 'Inactive').innerText());
  expect(inactive).toBeGreaterThanOrEqual(3);
  await expect(m.figure('Listings by status', 'Total')).toHaveText(String(12 + inactive));
  // The CRM imports of the last 30 days.
  await expect(m.figure('Changes by channel (last 30 days)', 'Import')).toHaveText('6');
});

test('connector runs: problems only by default, all on request', async ({ page }) => {
  const m = monitoring(page);
  await expect(m.problemsOnly).toBeChecked();
  await expect(m.runs.getByRole('columnheader')).toContainText(['Connector', ...RUN_COLUMNS]);
  // Three of the four demo runs had an error or rejected records.
  await expect(m.runRows).toHaveCount(3);
  await expect(m.runRows.filter({ hasText: 'Error' })).toHaveCount(1);

  await m.problemsOnly.uncheck();
  await expect(m.runRows).toHaveCount(4);
  for (const row of await m.runRows.all()) await expect(row).toContainText('nordlicht-crm');
});

test('rejected records: the fields and reasons of a run', async ({ page }) => {
  const m = monitoring(page);
  // The second run rejected two records (a negative area, a record without identity).
  const run = m.runRows
    .filter({ hasText: 'Success' })
    .filter({ has: page.getByRole('cell', { name: '2', exact: true }) });
  await run.first().getByRole('button', { name: 'Show rejections' }).click();
  const details = m.runs.getByRole('table', {
    name: /^Rejected records of nordlicht-crm, started /,
  });
  await expect(details).toBeVisible();
  await expect(details).toContainText('CRM-4721');
  await expect(details).toContainText('area');
  await expect(details).toContainText('without identifier');
  await m.runs.getByRole('button', { name: 'Hide rejections' }).click();
  await expect(details).toHaveCount(0);
});

test('usage: detail views and search impressions per day, also as a table', async ({ page }) => {
  const m = monitoring(page);
  const detailViews = m.usage.getByRole('figure', {
    name: /^Detail views Total in period: [\d,]+$/,
  });
  await expect(detailViews).toBeVisible();
  await expect(m.usage.getByRole('figure', { name: /^Search impressions/ })).toBeVisible();
  await expect(detailViews.getByRole('img')).toHaveAccessibleName(
    /Time series with 1 series and 30 values from/,
  );
  await detailViews.getByText('Show values as table').click();
  await expect(detailViews.getByRole('table')).toBeVisible();
  await expect(detailViews.getByRole('table').getByRole('row')).toHaveCount(31); // header + 30 days
  await expect(m.usage.getByRole('heading', { level: 3, name: 'Per listing' })).toBeVisible();
});

test('usage: the period is validated', async ({ page }) => {
  const m = monitoring(page);
  await m.usage.getByRole('textbox', { name: 'From' }).fill('2026-12-31');
  await m.usage.getByRole('textbox', { name: 'To' }).fill('2026-01-01');
  await m.usage.getByRole('button', { name: 'Show' }).click();
  await expect(m.usage.getByRole('alert').first()).toHaveText(
    'The start date must not be after the end date.',
  );
  await m.usage.getByRole('textbox', { name: 'From' }).fill('2020-01-01');
  await m.usage.getByRole('button', { name: 'Show' }).click();
  await expect(m.usage.getByRole('alert').first()).toContainText('The period may cover at most');
});

test('agency members read the monitoring too', async ({ browser }) => {
  const page = await browser.newPage();
  try {
    await new PortalPage(page).signIn(USERS.max, '/portal/monitoring');
    await expect(monitoring(page).figure('Listings by status', 'Active')).toHaveText('12');
  } finally {
    await page.close();
  }
});
