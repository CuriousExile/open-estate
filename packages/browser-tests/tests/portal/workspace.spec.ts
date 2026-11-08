import type { Page } from '@playwright/test';
import { expect, test } from '../../support/fixtures';
import { AGENCIES, PortalPage, USERS } from '../../support/portal';
import { Workspace } from '../../support/workspace';

// The listing workspace (Req 5.8, 7.x, 8.x, 12.15) of seeded listings, read-only: header facts,
// public preview, version history with compare and the restore preview (cancelled), field
// provenance of an imported listing. Restoring for real is in agency.serial.spec.ts.

const BERLIN_MITTE = '[DEMO] Helle 3-Zimmer-Altbauwohnung in Berlin-Mitte';
const WINTERHUDE = '4-Zimmer-Wohnung mit Alsterblick – provisionsfrei';
const PRENZLAUER_BERG = '[DEMO] 2-Zimmer-Wohnung am Kollwitzplatz';

async function openWorkspace(page: Page, title: string): Promise<Workspace> {
  await new PortalPage(page).signIn(USERS.anna);
  await page.getByRole('link', { name: title, exact: true }).click();
  const workspace = new Workspace(page);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(title);
  return workspace;
}

test('the header shows status, origin, source, custom ID and version', async ({ page }) => {
  const workspace = await openWorkspace(page, BERLIN_MITTE);
  await expect(workspace.meta('Status')).toHaveText('Active');
  await expect(workspace.meta('Origin')).toHaveText('Created manually');
  await expect(workspace.meta('Source')).toHaveText(`agency:${AGENCIES.nordlicht.agencyId}`);
  await expect(workspace.meta('Custom ID')).toHaveText('NL-BER-001');
  await expect(workspace.meta('Version')).toHaveText('4');
  await expect(page.getByRole('link', { name: 'Edit listing' })).toBeVisible();
});

test('the preview shows the listing like the public detail view (Req 5.8)', async ({ page }) => {
  const workspace = await openWorkspace(page, BERLIN_MITTE);
  await expect(workspace.tab('Preview')).toHaveAttribute('aria-selected', 'true');
  const preview = workspace.panel.getByRole('article');
  // Like the public page in the active UI language: the English version of the listing (the
  // header shows the stored original title).
  await expect(preview.getByRole('heading', { level: 2 })).toHaveText(
    '[DEMO] Bright 3-room period apartment in Berlin-Mitte',
  );
  await expect(preview.getByRole('region', { name: 'Offers' })).toContainText('€469,000');
  await expect(preview.getByRole('region', { name: 'Key facts' })).toContainText('82.5 m²');
  // Active: no "not public yet" hint.
  await expect(workspace.panel).not.toContainText('This listing is inactive.');
});

test('the tabs work with the arrow keys', async ({ page }) => {
  const workspace = await openWorkspace(page, BERLIN_MITTE);
  await workspace.tab('Preview').focus();
  await page.keyboard.press('ArrowRight');
  await expect(workspace.tab('Field provenance')).toHaveAttribute('aria-selected', 'true');
  await expect(workspace.tab('Field provenance')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(workspace.tab('History')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowLeft');
  await expect(workspace.tab('Field provenance')).toHaveAttribute('aria-selected', 'true');
});

test.describe('history', () => {
  test('lists every version, newest first, with type, channel and actor (Req 7.x)', async ({
    page,
  }) => {
    const workspace = await openWorkspace(page, BERLIN_MITTE);
    await workspace.tab('History').click();
    await expect(workspace.versions).toHaveCount(4);
    await expect(workspace.versions.first()).toContainText('Version 4');
    const expected = [
      [4, 'Updated', USERS.max],
      [3, 'Updated', USERS.anna],
      [2, 'Status changed', USERS.anna],
      [1, 'Created', USERS.max],
    ] as const;
    for (const [version, type, user] of expected) {
      await expect(workspace.version(version)).toContainText(type);
      await expect(workspace.version(version)).toContainText(`Portal · User ${user.displayName}`);
    }
    await expect(workspace.version(4)).toContainText('Current');
    // The current version cannot be restored; older ones can.
    await expect(workspace.version(4).getByRole('button', { name: /Restore/ })).toHaveCount(0);
    await expect(
      workspace.version(1).getByRole('button', { name: 'Restore version 1' }),
    ).toBeVisible();
  });

  test('comparing two versions shows the changed fields', async ({ page }) => {
    const workspace = await openWorkspace(page, BERLIN_MITTE);
    await workspace.tab('History').click();
    await expect(workspace.panel).toContainText(
      'Select two versions in the history to compare them.',
    );
    await workspace.compare(2, 3);
    await expect(workspace.panel).toContainText('Changes from version 2 to version 3');
    const diff = workspace.panel.getByRole('table');
    // The price reduction of version 3: 489,000 → 469,000.
    await expect(diff).toContainText('489000');
    await expect(diff).toContainText('469000');
  });

  test('a restore is recorded as its own version', async ({ page }) => {
    const workspace = await openWorkspace(page, PRENZLAUER_BERG);
    await workspace.tab('History').click();
    await expect(workspace.version(4)).toContainText('Restored');
    await expect(workspace.version(4)).toContainText('Restored from version 1');
  });

  test('the restore dialog previews the changes; "Cancel" changes nothing (Req 8.x)', async ({
    page,
  }) => {
    const workspace = await openWorkspace(page, BERLIN_MITTE);
    await workspace.tab('History').click();
    await workspace.version(1).getByRole('button', { name: 'Restore version 1' }).click();

    const dialog = page.getByRole('dialog', { name: 'Restore version 1?' });
    await expect(dialog).toContainText(
      'The content of version 1 becomes a new version. These are the changes compared to the current',
    );
    await expect(dialog.getByRole('table')).toContainText('469000');
    await expect(dialog.getByRole('table')).toContainText('489000');
    await expect(dialog).toContainText(
      'Status, custom ID and agency of the listing stay unchanged.',
    );
    await expect(dialog.getByRole('button', { name: 'Restore version 1' })).toBeEnabled();
    await dialog.getByRole('button', { name: 'Cancel' }).click();

    await expect(dialog).toBeHidden();
    await expect(workspace.meta('Version')).toHaveText('4');
    await expect(workspace.versions).toHaveCount(4);
  });
});

test('field provenance: which channel and actor changed each field last (Req 12.15)', async ({
  page,
}) => {
  const workspace = await openWorkspace(page, WINTERHUDE);
  await workspace.tab('Field provenance').click();
  const table = workspace.panel.getByRole('table', { name: 'Field provenance' });
  const row = (field: string) =>
    table
      .getByRole('row')
      .filter({ has: page.getByRole('rowheader', { name: field, exact: true }) });
  // Imported from the CRM, then the title edited in the portal.
  await expect(row('title')).toContainText('Portal');
  await expect(row('title')).toContainText(`User ${USERS.max.displayName}`);
  await expect(row('offers')).toContainText('List import');
  await expect(row('offers')).toContainText('Connector nordlicht-crm');
  await expect(row('offers')).toContainText(/run nordlicht-crm-\d{4}-\d{2}-\d{2}/);
  await expect(row('address.city')).toContainText('List import');
});

test.describe('not available', () => {
  test('an unknown listing id', async ({ consoleGuard, page }) => {
    consoleGuard.allow(/Failed to load resource: .* 404 .*\/management\/listings\/does-not-exist/);
    await new PortalPage(page).signIn(USERS.anna, '/portal/listings/does-not-exist');
    const notice = page.getByRole('alert');
    await expect(notice.getByRole('heading', { name: 'Listing not available' })).toBeVisible();
    await expect(notice).toContainText(
      'This listing does not exist or you do not have access to it.',
    );
    await notice.getByRole('link', { name: 'Back to the listings' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Listings' })).toBeVisible();
  });

  test('a listing of another agency looks exactly like an unknown one', async ({
    browser,
    consoleGuard,
    page,
  }) => {
    // The id of a listing of Alpenblick, as the platform admin sees it.
    const admin = await browser.newPage();
    let id: string;
    try {
      await new PortalPage(admin).signIn(
        USERS.paula,
        `/portal/admin/listings?agencyId=${AGENCIES.alpenblick.agencyId}`,
      );
      const link = admin.getByRole('link', {
        name: '[DEMO] 2-Zimmer-Wohnung in Schwabing',
        exact: true,
      });
      id = ((await link.getAttribute('href')) ?? '').split('/').pop() ?? '';
      expect(id).not.toBe('');
    } finally {
      await admin.close();
    }

    consoleGuard.allow(/Failed to load resource: .* 404 .*\/management\/listings\//);
    await new PortalPage(page).signIn(USERS.anna, `/portal/listings/${id}`);
    await expect(page.getByRole('heading', { name: 'Listing not available' })).toBeVisible();
  });
});
