import { expect, type Locator, type Page, type Response } from '@playwright/test';

/** Query parameters of a search URL (`/?offerType=SALE&city=…`). */
export type SearchQuery = Readonly<Record<string, string>>;

/** `true` for a Search_API list request (`GET /api/listings?…`), not a detail request. */
export function isSearchRequest(url: string): boolean {
  return new URL(url).pathname === '/api/listings';
}

/**
 * The public search (`/`): search form, results and the listing detail opened from them. Locators
 * use roles and accessible names (English UI, `locale: 'en-US'`), the way users and assistive
 * technology find the controls.
 */
export class SearchPage {
  readonly form: Locator;
  readonly city: Locator;
  readonly group: Locator;
  readonly priceMin: Locator;
  readonly priceMax: Locator;
  readonly submitButton: Locator;
  readonly moreFiltersButton: Locator;
  readonly formErrors: Locator;
  readonly results: Locator;
  readonly resultTitles: Locator;
  readonly resultCards: Locator;
  readonly detail: Locator;
  readonly detailHeading: Locator;
  readonly backToResults: Locator;

  constructor(readonly page: Page) {
    this.form = page.getByRole('form', { name: 'Property search' });
    this.city = this.form.getByRole('combobox', { name: 'City' });
    this.group = this.form.getByRole('button', { name: /^Property group/ });
    this.priceMin = this.form.getByRole('textbox', { name: 'Minimum price' });
    this.priceMax = this.form.getByRole('textbox', { name: 'Maximum price' });
    this.submitButton = this.form.getByRole('button', { name: 'Search', exact: true });
    this.moreFiltersButton = this.form.getByRole('button', { name: /^More filters/ });
    this.formErrors = this.form.getByRole('alert');
    this.results = page.getByRole('region', { name: 'Search results' });
    this.resultCards = this.results.getByRole('listitem');
    this.resultTitles = this.results.getByRole('heading', { level: 3 });
    this.detail = page.getByRole('article');
    this.detailHeading = this.detail.getByRole('heading', { level: 2 });
    this.backToResults = page.getByRole('button', { name: 'Back to results' });
  }

  /** Opens `/` (or a search URL) and waits until the app has started. */
  async goto(query?: SearchQuery): Promise<void> {
    const search = query === undefined ? '' : `?${new URLSearchParams(query).toString()}`;
    await this.page.goto(`/${search}`);
    await expect(this.form).toBeVisible();
  }

  /** The radio of an offer type ("For sale", "For rent"). */
  offerType(label: 'For sale' | 'For rent'): Locator {
    return this.form.getByRole('radio', { name: label, exact: true });
  }

  /** Picks an offer type the way a user does: the radio itself is invisible, its label is the button. */
  async chooseOfferType(label: 'For sale' | 'For rent'): Promise<void> {
    await this.form.locator('label.oe-segmented-option', { hasText: label }).click();
    await expect(this.offerType(label)).toBeChecked();
  }

  /** Rooms chip: `undefined` = "Any", else "n+" (accessible name "At least n rooms"). */
  roomsChip(count?: number): Locator {
    return this.form.getByRole('radio', {
      name: count === undefined ? 'Any' : `At least ${count} rooms`,
      exact: true,
    });
  }

  async chooseRooms(count?: number): Promise<void> {
    const id = await this.roomsChip(count).getAttribute('id');
    await this.form.locator(`label[for="${id}"]`).click();
    await expect(this.roomsChip(count)).toBeChecked();
  }

  /** Chooses an option of an `oe-select` dropdown by its visible label. */
  async chooseOption(trigger: Locator, option: string): Promise<void> {
    await trigger.click();
    const listbox = this.page.locator(`[id="${await trigger.getAttribute('aria-controls')}"]`);
    await listbox.getByRole('option', { name: option }).click();
    await expect(listbox).toBeHidden();
  }

  /** Clicks "Search" and waits for the Search_API response of the new search. */
  async submit(): Promise<Response> {
    const response = this.page.waitForResponse((r) => isSearchRequest(r.url()));
    await this.submitButton.click();
    return response;
  }

  /** Waits until the result list shows the outcome of the current search (no request pending). */
  async waitForResults(): Promise<void> {
    await expect(this.results).toBeVisible();
    await expect(this.results).toHaveAttribute('aria-busy', 'false');
  }

  /** Result titles, sorted (the API orders by recency; the tests compare sets). */
  async titles(): Promise<string[]> {
    await this.waitForResults();
    return (await this.resultTitles.allInnerTexts()).map((t) => t.trim()).sort();
  }

  /** Asserts the result set (order-independent), retrying until the list settles. */
  async expectTitles(expected: readonly string[]): Promise<void> {
    await expect.poll(() => this.titles()).toEqual([...expected].sort());
  }

  /** The result card of a listing (title button inside). */
  card(title: string): Locator {
    return this.resultCards.filter({
      has: this.page.getByRole('button', { name: title, exact: true }),
    });
  }

  /** Opens a listing from the results by its title. */
  async openListing(title: string): Promise<void> {
    await this.results.getByRole('button', { name: title, exact: true }).click();
    await expect(this.detailHeading).toHaveText(title);
  }

  /** Current query parameters of the page URL. */
  query(): URLSearchParams {
    return new URL(this.page.url()).searchParams;
  }
}
