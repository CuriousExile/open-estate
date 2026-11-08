import type { Locator, Page } from '@playwright/test';

/** The listing workspace of the portal (`/portal/listings/:id`): header, tabs, history. */
export class Workspace {
  readonly header: Locator;
  readonly panel: Locator;

  constructor(readonly page: Page) {
    this.header = page.locator('header.head');
    this.panel = page.getByRole('tabpanel');
  }

  /** Value of a header fact by its label ("Status", "Origin", "Version", …). */
  meta(label: string): Locator {
    return this.header
      .locator('dt', { hasText: new RegExp(`^\\s*${label}\\s*$`) })
      .locator('xpath=following-sibling::dd[1]');
  }

  tab(name: 'Preview' | 'Field provenance' | 'History'): Locator {
    return this.page.getByRole('tab', { name, exact: true });
  }

  /** Entries of the version history (newest first). */
  get versions(): Locator {
    return this.panel.getByRole('list').first().getByRole('listitem');
  }

  version(n: number): Locator {
    return this.versions.filter({ hasText: new RegExp(`Version ${n}\\b`) });
  }

  async compare(a: number, b: number): Promise<void> {
    for (const n of [a, b]) {
      await this.version(n)
        .getByRole('checkbox', { name: /Select for comparison/ })
        .check();
    }
  }
}
