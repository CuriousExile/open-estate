import type { Routes } from '@angular/router';
import { PortalPlaceholderComponent } from '../portal-placeholder.component';

/**
 * `/portal/monitoring` (Req 13.6, 15.5): task 14.7 replaces the placeholder with
 * `AgencyMonitoringComponent`. Inherits `access: monitoring:read`.
 */
export const MONITORING_ROUTES: Routes = [
  {
    path: '',
    component: PortalPlaceholderComponent,
    data: { titleKey: 'portal.monitoring.title' },
  },
];
