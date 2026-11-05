import type { Routes } from '@angular/router';
import { AgencyMonitoringComponent } from './agency-monitoring.component';

/** `/portal/monitoring` (Req 13.6, 15.5). Inherits `access: monitoring:read`. */
export const MONITORING_ROUTES: Routes = [{ path: '', component: AgencyMonitoringComponent }];
