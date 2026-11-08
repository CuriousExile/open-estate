import type { Locator, Page } from '@playwright/test';

/**
 * "Manage this listing" above the public detail view (search and `/listings/:id`), for users
 * signed in to the portal in this tab who may manage the listing.
 */
export function manageBar(page: Page) {
  const region = page.getByRole('region', { name: 'Manage this listing' });
  return {
    region,
    state: region.getByRole('paragraph').first(),
    deactivate: region.getByRole('button', { name: 'Deactivate', exact: true }),
    activate: region.getByRole('button', { name: 'Activate', exact: true }),
    edit: region.getByRole('link', { name: 'Edit listing' }),
    open: region.getByRole('link', { name: 'Open in portal' }),
    notice: region.getByRole('status'),
  } satisfies Record<string, Locator>;
}
