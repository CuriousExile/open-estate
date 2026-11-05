import type { Routes } from '@angular/router';
import { authGuard } from '../auth/auth.guard';
import { permissionGuard } from '../auth/permission.guard';
import type { AccessRequirement } from '../auth/portal-access';
import { PortalNoticeComponent } from './portal-notice.component';
import { PortalShellComponent } from './portal-shell.component';

const access = (requirement: AccessRequirement) => ({ access: requirement });

/**
 * Routes under `/portal` (lazy, design: Agentur_Portal und Admin_Modus). `/portal` is also the OIDC
 * callback. Every area lives in its own folder with its own `*.routes.ts`; `data.access` is
 * checked by `permissionGuard` against `GET /me`.
 */
export const PORTAL_ROUTES: Routes = [
  // Outside the guards: shown when the login cannot run or failed — never loops into the login.
  { path: 'unavailable', component: PortalNoticeComponent },
  {
    path: '',
    component: PortalShellComponent,
    canActivate: [authGuard],
    canActivateChild: [permissionGuard],
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'listings' },
      { path: 'forbidden', component: PortalNoticeComponent, data: { reason: 'forbidden' } },
      {
        path: 'listings',
        data: access({ permissions: ['listing:read'] }),
        loadChildren: () => import('./listings/listings.routes').then((m) => m.LISTINGS_ROUTES),
      },
      {
        path: 'monitoring',
        data: access({ permissions: ['monitoring:read'] }),
        loadChildren: () =>
          import('./monitoring/monitoring.routes').then((m) => m.MONITORING_ROUTES),
      },
      {
        path: 'team',
        data: access({ permissions: ['member:manage'] }),
        loadChildren: () => import('./team/team.routes').then((m) => m.TEAM_ROUTES),
      },
      {
        path: 'machine-access',
        data: access({ permissions: ['machine-access:manage'] }),
        loadChildren: () =>
          import('./machine-access/machine-access.routes').then((m) => m.MACHINE_ACCESS_ROUTES),
      },
      {
        path: 'audit',
        data: access({ permissions: ['audit:read'] }),
        loadChildren: () => import('./audit/audit.routes').then((m) => m.AUDIT_ROUTES),
      },
      {
        path: 'admin',
        data: access({ platformAdmin: true }),
        loadChildren: () => import('./admin/admin.routes').then((m) => m.ADMIN_ROUTES),
      },
      { path: '**', redirectTo: 'listings' },
    ],
  },
];
