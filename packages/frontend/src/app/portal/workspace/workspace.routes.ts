import type { Routes } from '@angular/router';
import { PortalPlaceholderComponent } from '../portal-placeholder.component';

/**
 * `/portal/listings/:id` (Req 5.8, 7.8, 8.6, 12.15): preview, field provenance and history — task
 * 14.4 replaces the placeholder with `ListingWorkspaceComponent`. `:id` is bound from the parent.
 */
export const WORKSPACE_ROUTES: Routes = [
  {
    path: '',
    component: PortalPlaceholderComponent,
    data: { titleKey: 'portal.workspace.title' },
  },
];
