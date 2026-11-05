import type { Routes } from '@angular/router';
import { PortalPlaceholderComponent } from '../portal-placeholder.component';

/**
 * `/portal/listings` (Req 5.2–5.5): overview and form — task 14.3 replaces the placeholders with
 * `ListingTableComponent` and `ListingFormComponent`. `:id` is the workspace (own folder, 14.4).
 * Inherits `access: listing:read` from the parent route.
 */
export const LISTINGS_ROUTES: Routes = [
  {
    path: '',
    pathMatch: 'full',
    component: PortalPlaceholderComponent,
    data: { titleKey: 'portal.listings.title' },
  },
  {
    path: 'new',
    component: PortalPlaceholderComponent,
    data: { titleKey: 'portal.listings.new', access: { permissions: ['listing:write'] } },
  },
  {
    path: ':id/edit',
    component: PortalPlaceholderComponent,
    data: { titleKey: 'portal.listings.edit', access: { permissions: ['listing:write'] } },
  },
  {
    path: ':id',
    loadChildren: () => import('../workspace/workspace.routes').then((m) => m.WORKSPACE_ROUTES),
  },
];
