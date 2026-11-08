import { expect, type Locator, type Page } from '@playwright/test';
import { BASE_URL, DEV_SERVER_URL } from './env';

// Agency portal and admin mode: demo users (packages/devserver/src/seed/demo-data.ts), sign-in
// through the local OIDC provider, and the portal frame.

export interface DemoUser {
  email: string;
  displayName: string;
}

export const USERS = {
  /** PLATFORM_ADMIN, no agency: admin mode. */
  paula: { email: 'paula.platform@example.org', displayName: 'Paula Plattform' },
  /** AGENCY_ADMIN of Nordlicht Immobilien (active). */
  anna: { email: 'anna.admin@nordlicht.example.org', displayName: 'Anna Albers' },
  /** AGENCY_MEMBER of Nordlicht Immobilien: listings and monitoring only. */
  max: { email: 'max.member@nordlicht.example.org', displayName: 'Max Meyer' },
  /** AGENCY_ADMIN of Alpenblick Makler, which is suspended. */
  sepp: { email: 'sepp.admin@alpenblick.example.org', displayName: 'Sepp Brandl' },
} as const satisfies Record<string, DemoUser>;

export const AGENCIES = {
  nordlicht: { agencyId: 'agency-nordlicht', displayName: 'Nordlicht Immobilien' },
  alpenblick: { agencyId: 'agency-alpenblick', displayName: 'Alpenblick Makler' },
} as const;

/** Navigation entries of the portal (`PORTAL_NAV`), in order. */
export const NAV = {
  listings: 'Listings',
  monitoring: 'Monitoring',
  team: 'Team',
  machineAccess: 'Machine access',
  audit: 'Audit log',
  admin: 'Administration',
} as const;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The local login page of the dev server (`/oidc/authorize`, no password). */
export function loginPage(page: Page) {
  return {
    isShown: () => page.url().startsWith(`${DEV_SERVER_URL}/oidc/authorize`),
    user: (user: DemoUser) =>
      page.getByRole('button', { name: new RegExp(`${escapeRegExp(user.email)}`) }),
  };
}

/**
 * Signs in like a user: opens `target` (a portal URL), gets redirected to the local login page,
 * picks the user and returns to the SPA, which completes the code flow (PKCE) and opens `target`.
 * Tokens live in the tab's sessionStorage, so every page signs in on its own.
 */
export async function signIn(page: Page, user: DemoUser, target = '/portal'): Promise<void> {
  await page.goto(target);
  await page.waitForURL(`${DEV_SERVER_URL}/oidc/authorize**`);
  await loginPage(page).user(user).click();
  await page.waitForURL(
    (url) =>
      url.origin === BASE_URL &&
      url.pathname.startsWith('/portal') &&
      !url.search.includes('code='),
  );
}

/** The frame of the portal (navigation, user, sign-out) around every area. */
export class PortalPage {
  readonly nav: Locator;
  readonly signOutButton: Locator;
  readonly notice: Locator;

  constructor(readonly page: Page) {
    this.nav = page.getByRole('navigation', { name: 'Portal' });
    this.signOutButton = this.nav.getByRole('button', { name: 'Sign out' });
    this.notice = page.getByRole('alert').filter({ has: page.getByRole('heading', { level: 1 }) });
  }

  /** Signs in and waits for the portal frame with the user's name. */
  async signIn(user: DemoUser, target = '/portal'): Promise<void> {
    await signIn(this.page, user, target);
    await expect(this.nav).toContainText(user.displayName);
  }

  navLink(name: string): Locator {
    return this.nav.getByRole('link', { name, exact: true });
  }

  /** Names of the navigation entries, in order. */
  async navNames(): Promise<string[]> {
    return (await this.nav.getByRole('listitem').allInnerTexts()).map((t) => t.trim());
  }

  /** Main heading of the current area. */
  heading(name: string | RegExp): Locator {
    return this.page.getByRole('heading', { level: 1, name });
  }

  /** A `<table>` by its caption (accessible name). */
  table(caption: string): Locator {
    return this.page.getByRole('table', { name: caption });
  }

  /** The row of a table whose header cell (first column) has this text. */
  row(table: Locator, rowHeader: string | RegExp): Locator {
    return table
      .getByRole('row')
      .filter({ has: this.page.getByRole('rowheader', { name: rowHeader }) });
  }
}
