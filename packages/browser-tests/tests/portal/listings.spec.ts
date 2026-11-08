import type { Page } from '@playwright/test';
import { expect, test } from '../../support/fixtures';
import { createListing, ListingForm } from '../../support/listing-form';
import { PortalPage, USERS } from '../../support/portal';
import { unique } from '../../support/unique';
import { Workspace } from '../../support/workspace';

// Listing overview with filters (Req 5.2, 4.14) and the listing form (Req 5.3–5.5, 5.9). Tests run
// in parallel: they only read seeded listings and create their own, inactive ones (never public).

/** Seeded listings of Nordlicht Immobilien by Custom_Id, titles as stored (original language). */
const SEEDED = {
  berlinMitte: {
    customId: 'NL-BER-001',
    title: '[DEMO] Helle 3-Zimmer-Altbauwohnung in Berlin-Mitte',
  },
  eppendorf: {
    customId: 'NL-HH-004',
    title: '[DEMO] Penthouse mit Dachterrasse in Eppendorf (Entwurf)',
  },
  potsdam: { customId: 'NL-P-007', title: '[DEMO] Stadtvilla am Heiligen See (reserviert)' },
  bremen: { customId: 'CRM-4714', title: '[DEMO] Doppelhaushälfte in Bremen-Horn' },
  winterhude: { customId: 'CRM-4711', title: '4-Zimmer-Wohnung mit Alsterblick – provisionsfrei' },
  charlottenburg: { customId: 'CRM-4712', title: '[DEMO] 3,5-Zimmer-Altbau in Charlottenburg' },
  rostock: { customId: 'CRM-4713', title: '[DEMO] Ferienwohnung in Warnemünde, 200 m zum Strand' },
} as const;

function overview(page: Page) {
  const portal = new PortalPage(page);
  const table = portal.table('Listings of your agency');
  const filters = page.getByRole('form', { name: 'Filter listings' });
  return {
    portal,
    table,
    filters,
    row: (title: string) => portal.row(table, title),
    titles: async () => (await table.getByRole('rowheader').allInnerTexts()).map((t) => t.trim()),
    async apply() {
      const loaded = page.waitForResponse(
        (r) => new URL(r.url()).pathname === '/management/listings',
      );
      await filters.getByRole('button', { name: 'Apply filters' }).click();
      await loaded;
      await expect(page.locator('.table-wrap')).toHaveAttribute('aria-busy', 'false');
    },
    async chooseFilter(label: string, option: string) {
      const trigger = filters.getByRole('button', { name: new RegExp(`^${label} `) });
      await trigger.click();
      await page
        .locator(`[id="${await trigger.getAttribute('aria-controls')}"]`)
        .getByRole('option', { name: option, exact: true })
        .click();
    },
  };
}

test.describe('overview', () => {
  test.beforeEach(async ({ page }) => {
    await new PortalPage(page).signIn(USERS.anna, '/portal/listings');
  });

  test('lists the agency’s listings with status, origin, custom ID, offers and type', async ({
    page,
  }) => {
    const o = overview(page);
    await expect(o.row(SEEDED.berlinMitte.title)).toBeVisible();
    const cells = o.row(SEEDED.berlinMitte.title).getByRole('cell');
    await expect(cells.nth(0)).toHaveText('Active');
    await expect(cells.nth(1)).toHaveText('Manual');
    await expect(cells.nth(2)).toHaveText('NL-BER-001');
    await expect(cells.nth(3)).toHaveText('For sale');
    await expect(cells.nth(4)).toHaveText('Apartment');
    await expect(o.row(SEEDED.bremen.title).getByRole('cell').nth(0)).toHaveText('Inactive');
    await expect(o.row(SEEDED.bremen.title).getByRole('cell').nth(1)).toHaveText('Import');
    // Only this agency: the suspended agency's listings are not here.
    expect(await o.titles()).not.toContainEqual(expect.stringContaining('Schwabing'));
    await expect(
      o
        .row(SEEDED.berlinMitte.title)
        .getByRole('link', { name: `Edit ${SEEDED.berlinMitte.title}` }),
    ).toBeVisible();
  });

  test('filters by status', async ({ page }) => {
    const o = overview(page);
    await o.chooseFilter('Status', 'Inactive');
    await o.apply();
    const titles = await o.titles();
    expect(titles).toEqual(
      expect.arrayContaining([SEEDED.eppendorf.title, SEEDED.potsdam.title, SEEDED.bremen.title]),
    );
    expect(titles).not.toContain(SEEDED.berlinMitte.title);
    for (const status of await o.table
      .getByRole('row')
      .locator('td:nth-child(2)')
      .allInnerTexts()) {
      // A flagged duplicate also shows its "Possible duplicate" badge in the cell.
      expect(status.trim()).toMatch(/^Inactive\b/);
    }
  });

  test('filters by origin: the four CRM imports', async ({ page }) => {
    const o = overview(page);
    await o.chooseFilter('Origin', 'Import');
    await o.apply();
    expect((await o.titles()).sort()).toEqual(
      [SEEDED.winterhude, SEEDED.charlottenburg, SEEDED.rostock, SEEDED.bremen]
        .map((l) => l.title)
        .sort(),
    );
  });

  test('filters by custom ID, title and property type; Reset shows all again', async ({ page }) => {
    const o = overview(page);
    await o.filters.getByRole('textbox', { name: 'Custom ID' }).fill('NL-BER-001');
    await o.apply();
    expect(await o.titles()).toEqual([SEEDED.berlinMitte.title]);

    await o.filters.getByRole('textbox', { name: 'Custom ID' }).fill('');
    await o.filters.getByRole('searchbox', { name: 'Title contains' }).fill('Loft');
    await o.apply();
    expect((await o.titles()).sort()).toEqual(
      ['[DEMO] Loft in der HafenCity – Kauf oder Miete', '[DEMO] Office loft in Kreuzberg'].sort(),
    );

    await o.filters.getByRole('searchbox', { name: 'Title contains' }).fill('');
    await o.filters.getByRole('combobox', { name: 'Property type' }).selectOption('villa');
    await o.apply();
    expect(await o.titles()).toEqual([SEEDED.potsdam.title]);

    const all = page.waitForResponse((r) => new URL(r.url()).pathname === '/management/listings');
    await o.filters.getByRole('button', { name: 'Reset' }).click();
    await all;
    await expect(o.row(SEEDED.berlinMitte.title)).toBeVisible();
    expect((await o.titles()).length).toBeGreaterThanOrEqual(14);
  });

  test('filters by offer type', async ({ page }) => {
    const o = overview(page);
    await o.chooseFilter('Offer type', 'For rent');
    await o.apply();
    const titles = await o.titles();
    expect(titles).toContain(SEEDED.charlottenburg.title);
    expect(titles).not.toContain(SEEDED.berlinMitte.title);
  });
});

test.describe('creating and editing', () => {
  test('a new listing is created inactive and opens in its workspace (Req 4.2)', async ({
    page,
    request,
  }, testInfo) => {
    const portal = new PortalPage(page);
    await portal.signIn(USERS.anna);
    await page.getByRole('link', { name: 'New listing' }).click();
    await expect(portal.heading('New listing')).toBeVisible();
    const form = new ListingForm(page);
    // Defaults: one sale offer in the default currency, status inactive, UI language.
    await expect(form.select('Status')).toContainText('Inactive');
    await expect(form.field('Currency')).toHaveValue('EUR');
    await expect(form.select('Original language')).toContainText('English');

    const title = `Browser test ${unique(testInfo)}`;
    const city = `Teststadt ${unique(testInfo, 'c')}`;
    await form.fill({ title, city, price: '312000' });
    const id = await form.saveAndOpen();

    await expect(portal.heading(title)).toBeVisible();
    const workspace = new Workspace(page);
    await expect(workspace.meta('Status')).toHaveText('Inactive');
    await expect(workspace.meta('Origin')).toHaveText('Created manually');
    await expect(workspace.meta('Version')).toHaveText('1');
    // The preview shows how it would look publicly, with a hint that it is not public yet.
    await expect(page.getByText('This listing is inactive.')).toBeVisible();
    await expect(page.getByRole('article').getByRole('heading', { level: 2 })).toHaveText(title);

    // Not public: neither in the search nor as a detail page.
    const search = await request.get(
      `/api/listings?offerType=SALE&city=${encodeURIComponent(city)}`,
    );
    expect(((await search.json()) as { items: unknown[] }).items).toEqual([]);
    expect((await request.get(`/api/listings/${id}`)).status()).toBe(404);

    // And it is in the agency's overview.
    await page.getByRole('link', { name: 'Back to the listings' }).click();
    await expect(overview(page).row(title)).toBeVisible();
  });

  test('invalid input names every field, focuses the first and saves nothing (Req 5.4)', async ({
    page,
  }) => {
    await new PortalPage(page).signIn(USERS.anna, '/portal/listings/new');
    const form = new ListingForm(page);
    let posted = false;
    page.on('request', (r) => {
      if (r.method() === 'POST' && new URL(r.url()).pathname === '/management/listings')
        posted = true;
    });
    await form.field('Purchase price').fill('cheap');
    await form.field('Country').fill('Germany');
    await form.save.click();

    await expect(form.errors).toContainText('entries need your attention. Nothing has been saved.');
    const items = form.errors.getByRole('listitem');
    await expect(items.filter({ hasText: 'Title' })).toContainText('Enter 1 to 300 characters.');
    await expect(items.filter({ hasText: 'Property type' })).toContainText(
      'Choose a property type.',
    );
    await expect(items.filter({ hasText: 'Purchase price' })).toContainText('Enter an amount');
    await expect(items.filter({ hasText: 'Country' })).toContainText(
      'Enter a two-letter country code such as DE.',
    );
    await expect(form.field('Title')).toBeFocused();
    await expect(form.field('Title')).toHaveAttribute('aria-invalid', 'true');
    // Entries are kept; a click on an error moves to its field.
    await expect(form.field('Purchase price')).toHaveValue('cheap');
    await items.filter({ hasText: 'Country' }).getByRole('button').click();
    await expect(form.field('Country')).toBeFocused();
    expect(posted).toBe(false);
  });

  test('a rent offer: the warm rent must not be lower than the cold rent', async ({
    page,
  }, testInfo) => {
    await new PortalPage(page).signIn(USERS.anna, '/portal/listings/new');
    const form = new ListingForm(page);
    await form.fill({ title: `Rent ${unique(testInfo)}` });
    await form.choose('Offer type', 'For rent');
    await form.field('Cold rent per month').fill('1200');
    await form.field('Additional costs per month').fill('200');
    await form.field('Warm rent per month').fill('1000');
    await form.save.click();
    await expect(form.errors).toContainText('The warm rent must not be lower than the cold rent.');

    await form.field('Warm rent per month').fill('1400');
    await form.saveAndOpen();
    await expect(page.getByRole('article')).toContainText('Cold rent per month');
  });

  test('a custom ID already used in the agency is refused and the entries are kept', async ({
    consoleGuard,
    page,
  }, testInfo) => {
    consoleGuard.allow(/Failed to load resource: .* 409 .*\/management\/listings\)$/);
    await new PortalPage(page).signIn(USERS.anna, '/portal/listings/new');
    const form = new ListingForm(page);
    const title = `Duplicate ${unique(testInfo)}`;
    await form.fill({ title, customId: SEEDED.berlinMitte.customId });
    await form.save.click();
    await expect(form.errors).toContainText(
      'This custom ID is already used by another listing of your agency.',
    );
    await expect(form.field('Title')).toHaveValue(title);
    await expect(page).toHaveURL(/\/portal\/listings\/new$/);
  });

  test('editing creates a new version; the history compares two versions', async ({
    page,
  }, testInfo) => {
    const portal = new PortalPage(page);
    await portal.signIn(USERS.max);
    const title = `Edit ${unique(testInfo)}`;
    await createListing(page, { title, price: '400000' });

    await page.getByRole('link', { name: 'Edit listing' }).click();
    const form = new ListingForm(page);
    await expect(form.field('Title')).toHaveValue(title);
    // The status of an existing listing is not part of the form.
    await expect(form.select('Status')).toHaveCount(0);
    await form.field('Purchase price').fill('385000');
    await form.saveAndOpen();
    const workspace = new Workspace(page);
    await expect(workspace.meta('Version')).toHaveText('2');

    await workspace.tab('History').click();
    await expect(workspace.versions).toHaveCount(2);
    await expect(workspace.version(2)).toContainText('Updated');
    await expect(workspace.version(2)).toContainText('Current');
    await expect(workspace.version(2)).toContainText(`Portal · User ${USERS.max.displayName}`);
    await expect(workspace.version(1)).toContainText('Created');

    await workspace.compare(1, 2);
    const history = workspace.panel;
    await expect(history).toContainText('Changes from version 1 to version 2');
    const diff = history.getByRole('table');
    await expect(diff).toContainText('400000');
    await expect(diff).toContainText('385000');
  });

  test('a concurrent edit is detected: entries kept, diff shown, overwrite on request (Req 5.5)', async ({
    browser,
    page,
  }, testInfo) => {
    await new PortalPage(page).signIn(USERS.anna);
    const title = `Conflict ${unique(testInfo)}`;
    const id = await createListing(page, { title, price: '500000' });

    // A second tab (own session) opens the same version for editing.
    const other = await browser.newPage();
    try {
      await new PortalPage(other).signIn(USERS.max, `/portal/listings/${id}/edit`);
      const otherForm = new ListingForm(other);
      await expect(otherForm.field('Title')).toHaveValue(title);

      // The first tab saves first …
      await page.goto(`/portal/listings/${id}/edit`);
      const form = new ListingForm(page);
      await form.field('Purchase price').fill('490000');
      await form.saveAndOpen();

      // … so the second tab's save is based on an outdated version.
      await otherForm.field('Title').fill(`${title} (renamed)`);
      await otherForm.save.click();
      const conflict = otherForm.region.getByRole('alert', {
        name: 'The listing was changed in the meantime',
      });
      await expect(conflict).toContainText(
        'Your entries are based on version 1; the current version is 2.',
      );
      await expect(conflict.getByRole('table')).toContainText('490000');
      await expect(otherForm.field('Title')).toHaveValue(`${title} (renamed)`);

      await conflict
        .getByRole('button', { name: 'Save my entries as a new version after version 2' })
        .click();
      await other.waitForURL(`**/portal/listings/${id}`);
      await expect(other.getByRole('heading', { level: 1 })).toHaveText(`${title} (renamed)`);
      await expect(new Workspace(other).meta('Version')).toHaveText('3');
    } finally {
      await other.close();
    }
  });

  test('"Cancel" leaves the form without saving', async ({ page }) => {
    const portal = new PortalPage(page);
    await portal.signIn(USERS.anna, '/portal/listings/new');
    await new ListingForm(page).field('Title').fill('Never saved');
    await page.getByRole('link', { name: 'Cancel' }).click();
    await expect(portal.heading('Listings')).toBeVisible();
    await expect(overview(page).row('Never saved')).toHaveCount(0);
  });
});
