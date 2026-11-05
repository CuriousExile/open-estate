import type { Routes } from '@angular/router';
import { AuditLogComponent } from './audit-log.component';

/** `/portal/audit` (Req 11.5): the agency's Audit_Log. Inherits `access: audit:read`. */
export const AUDIT_ROUTES: Routes = [{ path: '', component: AuditLogComponent }];
