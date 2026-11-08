import { expect, test } from '../../support/fixtures';
import { DEV_SERVER_URL } from '../../support/env';
import { loginPage, NAV, PortalPage, signIn, USERS } from '../../support/portal';

// Sign-in (Code + PKCE against the local OIDC provider, Req 5.1), what each role may see (Req 5.6,
// 2.x), sign-out, and where the bearer token goes.

test.describe('sign-in', () => {
  test('an unauthenticated visit goes to the login page and returns to the portal', async ({
    page,
  }) => {
    const portal = new PortalPage(page);
    await page.goto('/portal');
    await page.waitForURL(`${DEV_SERVER_URL}/oidc/authorize**`);
    const authorize = new URL(page.url());
    // Authorization Code flow with PKCE (S256), back to the portal route of this SPA.
    expect(authorize.searchParams.get('response_type')).toBe('code');
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('code_challenge')).toMatch(/^[\w-]{43}$/);
    expect(new URL(authorize.searchParams.get('redirect_uri') ?? '').pathname).toBe('/portal');

    await loginPage(page).user(USERS.anna).click();
    await expect(portal.heading('Listings')).toBeVisible();
    await expect(page).toHaveURL(/\/portal\/listings$/);
    await expect(portal.nav).toContainText(USERS.anna.displayName);
  });

  test('a deep link survives the login (Req 5.1)', async ({ page }) => {
    const portal = new PortalPage(page);
    await signIn(page, USERS.anna, '/portal/machine-access');
    await expect(page).toHaveURL(/\/portal\/machine-access$/);
    await expect(portal.heading('Machine access')).toBeVisible();
  });

  test('signing out ends the session and returns to the public search', async ({ page }) => {
    const portal = new PortalPage(page);
    await portal.signIn(USERS.anna);
    await portal.signOutButton.click();

    await expect(page.getByRole('form', { name: 'Property search' })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe('/');
    // The portal asks for a login again.
    await page.goto('/portal/listings');
    await page.waitForURL(`${DEV_SERVER_URL}/oidc/authorize**`);
    await expect(loginPage(page).user(USERS.anna)).toBeVisible();
  });

  test('a failed login callback shows a notice instead of looping into the login', async ({
    consoleGuard,
    page,
  }) => {
    consoleGuard.allow(/./); // the OIDC client logs the rejected callback
    await page.goto('/portal?code=not-a-real-code&state=not-a-real-state');
    const notice = page.getByRole('alert', { name: 'Sign-in failed' });
    await expect(notice).toContainText('The sign-in could not be completed. Please try again.');
    await expect(page).toHaveURL(/\/portal\/unavailable\?reason=loginFailed$/);
    await expect(notice.getByRole('link', { name: 'To the search' })).toBeVisible();
  });

  test('without a portal configuration the portal is unavailable, the search still works', async ({
    page,
  }) => {
    await page.route('**/runtime-config.json', (route) =>
      route.fulfill({ json: { apiBaseUrl: '/api' } }),
    );
    await page.goto('/portal');
    const notice = page.getByRole('alert', { name: 'Portal unavailable' });
    await expect(notice).toContainText('The portal is not configured for this site.');
    expect(page.url()).not.toContain('/oidc/');
    await notice.getByRole('link', { name: 'To the search' }).click();
    await expect(page.getByRole('form', { name: 'Property search' })).toBeVisible();
  });
});

test.describe('what each role sees (Req 5.6)', () => {
  test('agency admin: listings, monitoring, team, machine access, audit log', async ({ page }) => {
    const portal = new PortalPage(page);
    await portal.signIn(USERS.anna);
    expect(await portal.navNames()).toEqual([
      NAV.listings,
      NAV.monitoring,
      NAV.team,
      NAV.machineAccess,
      NAV.audit,
    ]);
    await expect(page.getByRole('link', { name: 'New listing' })).toBeVisible();
  });

  test('agency member: listings and monitoring only; other areas are refused', async ({ page }) => {
    const portal = new PortalPage(page);
    await portal.signIn(USERS.max);
    expect(await portal.navNames()).toEqual([NAV.listings, NAV.monitoring]);
    // Members maintain listings (listing:write).
    await expect(page.getByRole('link', { name: 'New listing' })).toBeVisible();

    for (const [path, area] of [
      ['/portal/team', 'team'],
      ['/portal/machine-access', 'machine access'],
      ['/portal/audit', 'audit log'],
      ['/portal/admin', 'admin mode'],
    ] as const) {
      await page.goto(path);
      const notice = page.getByRole('alert', { name: 'No access' });
      await expect(notice, area).toContainText('You do not have permission to open this area.');
      await expect(page).toHaveURL(/\/portal\/forbidden$/);
    }
    await page.getByRole('link', { name: 'Back to the portal' }).click();
    await expect(portal.heading('Listings')).toBeVisible();
  });

  test('platform admin: every area plus administration; no agency of its own', async ({ page }) => {
    const portal = new PortalPage(page);
    await portal.signIn(USERS.paula);
    expect(await portal.navNames()).toEqual(Object.values(NAV));

    await portal.navLink(NAV.team).click();
    await expect(page.getByRole('region', { name: 'Team' })).toContainText(
      'Your account does not belong to an agency.',
    );
    await page.getByRole('link', { name: 'To the administration' }).click();
    await expect(page).toHaveURL(/\/portal\/admin\/agencies$/);
  });

  test('a user of a suspended agency gets no portal', async ({ consoleGuard, page }) => {
    consoleGuard.allow(/Failed to load resource: .* 403 .*\/management\/me/);
    await signIn(page, USERS.sepp);
    await expect(page).toHaveURL(/\/portal\/unavailable\?reason=session$/);
    const notice = page.getByRole('alert', { name: 'Account not available' });
    await expect(notice).toContainText('Your account details could not be loaded.');
    await expect(page.getByRole('navigation', { name: 'Portal' })).toHaveCount(0);
    await notice.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('form', { name: 'Property search' })).toBeVisible();
  });

  test('an unknown portal path leads to the listings', async ({ page }) => {
    const portal = new PortalPage(page);
    await portal.signIn(USERS.anna);
    await page.goto('/portal/does-not-exist');
    await expect(page).toHaveURL(/\/portal\/listings$/);
    await expect(portal.heading('Listings')).toBeVisible();
  });
});

test.describe('tokens', () => {
  test('the bearer token goes to the Management API only, never to the Search API', async ({
    page,
  }) => {
    const sent: { path: string; authorization: string | undefined }[] = [];
    page.on('request', async (request) => {
      const url = new URL(request.url());
      if (!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/management/')) return;
      sent.push({
        path: url.pathname,
        authorization: (await request.allHeaders())['authorization'],
      });
    });
    const portal = new PortalPage(page);
    await portal.signIn(USERS.anna);
    // Signed in, use the public search in the same tab.
    await page.goto('/?offerType=SALE');
    await expect(page.getByRole('region', { name: 'Search results' })).toBeVisible();
    await expect.poll(() => sent.some((r) => r.path === '/api/listings')).toBe(true);

    const management = sent.filter((r) => r.path.startsWith('/management/'));
    const search = sent.filter((r) => r.path.startsWith('/api/'));
    expect(management.length).toBeGreaterThan(0);
    for (const request of management) expect(request.authorization).toMatch(/^Bearer \S+$/);
    for (const request of search) expect(request.authorization, request.path).toBeUndefined();
  });
});
