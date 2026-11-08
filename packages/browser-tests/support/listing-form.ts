import { expect, type Locator, type Page } from '@playwright/test';

/** Content of a listing the portal tests create (only what the form needs). */
export interface NewListing {
  title: string;
  description?: string;
  /** Taxonomy code, e.g. `apartment_unit`. */
  listingType?: string;
  /** Purchase price of the (default) SALE offer, as typed. */
  price?: string;
  rooms?: string;
  area?: string;
  postalCode?: string;
  city?: string;
  country?: string;
  customId?: string;
  status?: 'Active' | 'Inactive';
}

/** The listing form of the portal (`/portal/listings/new`, `/portal/listings/:id/edit`). */
export class ListingForm {
  readonly region: Locator;
  readonly errors: Locator;
  readonly save: Locator;

  constructor(readonly page: Page) {
    this.region = page.getByRole('region', { name: /^(New listing|Edit listing)$/ });
    this.errors = this.region.getByRole('alert');
    this.save = this.region.getByRole('button', { name: 'Save', exact: true });
  }

  field(name: string): Locator {
    return this.region.getByRole('textbox', { name, exact: true });
  }

  get listingType(): Locator {
    return this.region.getByRole('combobox', { name: 'Property type' });
  }

  /** An `oe-select` of the form by its label, e.g. "Status". */
  select(label: string): Locator {
    return this.region.getByRole('button', { name: new RegExp(`^${label} `) });
  }

  async choose(label: string, option: string): Promise<void> {
    const trigger = this.select(label);
    await trigger.click();
    const listbox = this.page.locator(`[id="${await trigger.getAttribute('aria-controls')}"]`);
    await listbox.getByRole('option', { name: option, exact: true }).click();
    await expect(trigger).toContainText(option);
  }

  /** Fills a new listing; defaults make it valid (a sale in Germany, inactive). */
  async fill(listing: NewListing): Promise<void> {
    await this.field('Title').fill(listing.title);
    await this.field('Description').fill(listing.description ?? 'Created by a browser test.');
    await this.listingType.selectOption(listing.listingType ?? 'apartment_unit');
    await this.field('Purchase price').fill(listing.price ?? '250000');
    await this.field('Rooms').fill(listing.rooms ?? '3');
    await this.field('Area (m²)').fill(listing.area ?? '75');
    await this.field('Postal code').fill(listing.postalCode ?? '10115');
    await this.field('City').fill(listing.city ?? 'Berlin');
    await this.field('Country').fill(listing.country ?? 'DE');
    if (listing.customId !== undefined) await this.field('Custom ID').fill(listing.customId);
    if (listing.status !== undefined) await this.choose('Status', listing.status);
  }

  /** Saves and waits for the workspace of the listing; returns its id. */
  async saveAndOpen(): Promise<string> {
    const created = this.page.waitForResponse(
      (r) =>
        /\/management\/listings(\/[^/]+)?$/.test(new URL(r.url()).pathname) &&
        ['POST', 'PUT'].includes(r.request().method()),
    );
    await this.save.click();
    const response = await created;
    expect(response.ok(), `save answered ${response.status()}`).toBe(true);
    // The app opens the workspace; its URL names the id (the response body may be gone by then).
    await this.page.waitForURL((url) => /^\/portal\/listings\/(?!new$)[^/]+$/.test(url.pathname));
    return new URL(this.page.url()).pathname.split('/').pop() ?? '';
  }
}

/** Opens the new-listing form, fills and saves it; returns the id (signed-in page). */
export async function createListing(page: Page, listing: NewListing): Promise<string> {
  await page.goto('/portal/listings/new');
  const form = new ListingForm(page);
  await form.fill(listing);
  return form.saveAndOpen();
}
