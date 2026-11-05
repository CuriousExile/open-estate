import type { Routes } from '@angular/router';
import { PortalPlaceholderComponent } from '../portal-placeholder.component';

/**
 * `/portal/admin/*` — Admin_Modus, only for `PLATFORM_ADMIN` (inherited `access.platformAdmin`;
 * Req 10.1, 10.3, 10.4, 10.7, 10.8, 14.6). Task 14.9 replaces the placeholders.
 */
export const ADMIN_ROUTES: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'agencies' },
  {
    path: 'agencies',
    component: PortalPlaceholderComponent,
    data: { titleKey: 'portal.admin.agencies' },
  },
  {
    path: 'agencies/:id',
    component: PortalPlaceholderComponent,
    data: { titleKey: 'portal.admin.agency' },
  },
  {
    path: 'listings',
    component: PortalPlaceholderComponent,
    data: { titleKey: 'portal.admin.listings' },
  },
  {
    path: 'monitoring',
    component: PortalPlaceholderComponent,
    data: { titleKey: 'portal.admin.monitoring' },
  },
  {
    path: 'operations',
    component: PortalPlaceholderComponent,
    data: { titleKey: 'portal.admin.operations' },
  },
  {
    path: 'audit',
    component: PortalPlaceholderComponent,
    data: { titleKey: 'portal.admin.audit' },
  },
];
