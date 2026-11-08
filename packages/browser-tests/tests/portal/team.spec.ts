import type { Page } from '@playwright/test';
import { expect, test } from '../../support/fixtures';
import { loginPage, NAV, PortalPage, USERS } from '../../support/portal';
import { unique } from '../../support/unique';

// Team of an agency (Req 1.x): members, adding by e-mail, validation. Tests add their own members
// only; role changes and removals of seeded members are in agency.serial.spec.ts.

function team(page: Page) {
  const portal = new PortalPage(page);
  const invite = page.getByRole('form', { name: 'Add member' });
  const table = portal.table('Members of your agency');
  return {
    portal,
    invite,
    table,
    email: invite.getByRole('textbox', { name: 'Email address' }),
    role: invite.getByRole('combobox', { name: 'Role' }),
    add: invite.getByRole('button', { name: 'Add member' }),
    row: (name: string | RegExp) => portal.row(table, name),
  };
}

test.beforeEach(async ({ page }) => {
  await new PortalPage(page).signIn(USERS.anna, '/portal/team');
});

test('lists the members with e-mail and role', async ({ page }) => {
  const t = team(page);
  await expect(t.row(USERS.anna.displayName)).toContainText(USERS.anna.email);
  await expect(t.row(USERS.anna.displayName).getByRole('combobox')).toHaveValue('AGENCY_ADMIN');
  await expect(t.row(USERS.max.displayName)).toContainText(USERS.max.email);
  await expect(
    t
      .row(USERS.max.displayName)
      .getByRole('combobox', { name: `Role of ${USERS.max.displayName}` }),
  ).toHaveValue('AGENCY_MEMBER');
  await expect(
    t
      .row(USERS.max.displayName)
      .getByRole('button', { name: `Remove ${USERS.max.displayName} from the agency` }),
  ).toBeVisible();
  // Only this agency.
  await expect(t.table).not.toContainText(USERS.sepp.email);
});

test('a new member gets access at once and can sign in with the member role', async ({
  browser,
  page,
}, testInfo) => {
  const t = team(page);
  const email = `${unique(testInfo, 'member')}@example.org`;
  await t.email.fill(email);
  await expect(t.role).toHaveValue('AGENCY_MEMBER');
  await t.add.click();

  await expect(page.getByRole('status').filter({ hasText: 'now has access' })).toHaveText(
    `${email} now has access to your agency.`,
  );
  await expect(t.row(/./).filter({ hasText: email })).toContainText('Agency member');
  await expect(t.email).toHaveValue('');

  // The new member is offered on the local login page and sees the member areas.
  const other = await browser.newPage();
  try {
    await other.goto('/portal');
    await other.waitForURL('**/oidc/authorize**');
    await loginPage(other).user({ email, displayName: email }).click();
    const portal = new PortalPage(other);
    await expect(portal.nav).toBeVisible();
    expect(await portal.navNames()).toEqual([NAV.listings, NAV.monitoring]);
  } finally {
    await other.close();
  }
});

test('an invalid e-mail address is named and nothing is sent', async ({ page }) => {
  const t = team(page);
  let sent = false;
  page.on('request', (r) => {
    if (r.method() === 'POST' && new URL(r.url()).pathname.includes('/members')) sent = true;
  });
  await t.email.fill('not-an-email');
  await t.add.click();
  await expect(t.invite.getByRole('alert')).toHaveText('Enter a valid email address.');
  await expect(t.email).toHaveAttribute('aria-invalid', 'true');
  expect(sent).toBe(false);
});

test('a user of another agency cannot be added', async ({ consoleGuard, page }) => {
  consoleGuard.allow(/Failed to load resource: .* 409 /);
  const t = team(page);
  await t.email.fill(USERS.sepp.email);
  await t.add.click();
  await expect(t.invite.getByRole('alert')).toHaveText('This user already belongs to an agency.');
  await expect(t.table).not.toContainText(USERS.sepp.email);
});

test('removing a member asks for confirmation with the effects; "Cancel" keeps them', async ({
  page,
}) => {
  const t = team(page);
  await t
    .row(USERS.max.displayName)
    .getByRole('button', { name: /^Remove/ })
    .click();
  const dialog = page.getByRole('dialog', { name: `Remove ${USERS.max.displayName}?` });
  await expect(dialog).toContainText(
    `${USERS.max.displayName} (${USERS.max.email}) loses access to your agency within 60 seconds.`,
  );
  await expect(dialog).toContainText('Affected users: 1');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(t.row(USERS.max.displayName)).toBeVisible();
});
