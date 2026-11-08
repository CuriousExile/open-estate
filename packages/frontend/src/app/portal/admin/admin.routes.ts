import type { Routes } from '@angular/router';
import { ListingTableComponent } from '../listings/listing-table.component';
import { AdminAgenciesComponent } from './admin-agencies.component';
import { AdminAgencyDetailComponent } from './admin-agency-detail.component';
import { AdminAuditComponent } from './admin-audit.component';
import { AdminDuplicatesComponent } from './admin-duplicates.component';
import { AdminMonitoringComponent } from './admin-monitoring.component';
import { AdminOperationsComponent } from './admin-operations.component';
import { AdminShellComponent } from './admin-shell.component';

/**
 * `/portal/admin/*` — Admin_Modus, only for `PLATFORM_ADMIN` (inherited `access.platformAdmin`;
 * Req 10.1, 10.3, 10.4, 10.7, 10.8, 14.6). Lazy chunk of its own.
 */
export const ADMIN_ROUTES: Routes = [
  {
    path: '',
    component: AdminShellComponent,
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'agencies' },
      { path: 'agencies', component: AdminAgenciesComponent },
      { path: 'agencies/:id', component: AdminAgencyDetailComponent },
      // Cross-agency overview with agency filter (Req 10.4); rows open the workspace.
      { path: 'listings', component: ListingTableComponent, data: { agencyFilter: true } },
      { path: 'monitoring', component: AdminMonitoringComponent },
      { path: 'operations', component: AdminOperationsComponent },
      { path: 'audit', component: AdminAuditComponent },
      // Agenturübergreifende_Treffer of the Duplikat_Abgleich (duplicate-detection Req 11.7).
      { path: 'duplicates', component: AdminDuplicatesComponent },
    ],
  },
];
