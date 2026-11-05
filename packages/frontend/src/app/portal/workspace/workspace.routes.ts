import type { Routes } from '@angular/router';
import { ListingWorkspaceComponent } from './listing-workspace.component';

/**
 * `/portal/listings/:id` (Req 5.8, 7.8, 8.6, 12.15): preview, field provenance and history.
 * `:id` is bound from the parent route (inherited by this empty-path child).
 */
export const WORKSPACE_ROUTES: Routes = [{ path: '', component: ListingWorkspaceComponent }];
