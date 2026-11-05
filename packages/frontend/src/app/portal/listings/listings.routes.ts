import type { Routes } from '@angular/router';
import { ListingFormComponent } from './listing-form.component';
import { ListingTableComponent } from './listing-table.component';

/**
 * `/portal/listings` (Req 5.2–5.5): overview and create/edit form. `:id` is the workspace (own
 * folder, 14.4). Inherits `access: listing:read` from the parent route.
 */
export const LISTINGS_ROUTES: Routes = [
  { path: '', pathMatch: 'full', component: ListingTableComponent },
  {
    path: 'new',
    component: ListingFormComponent,
    data: { access: { permissions: ['listing:write'] } },
  },
  {
    path: ':id/edit',
    component: ListingFormComponent,
    data: { access: { permissions: ['listing:write'] } },
  },
  {
    path: ':id',
    loadChildren: () => import('../workspace/workspace.routes').then((m) => m.WORKSPACE_ROUTES),
  },
];
