import type { Routes } from '@angular/router';
import { PortalPlaceholderComponent } from '../portal-placeholder.component';

/**
 * `/portal/machine-access` (Req 3.1, 3.5, 3.7): task 14.8 replaces the placeholder. Inherits
 * `access: machine-access:manage`.
 */
export const MACHINE_ACCESS_ROUTES: Routes = [
  {
    path: '',
    component: PortalPlaceholderComponent,
    data: { titleKey: 'portal.machineAccess.title' },
  },
];
