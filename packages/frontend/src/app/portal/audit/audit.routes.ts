import type { Routes } from '@angular/router';
import { PortalPlaceholderComponent } from '../portal-placeholder.component';

/**
 * `/portal/audit` (Req 11.5): the agency's Audit_Log — task 14.8 replaces the placeholder.
 * Inherits `access: audit:read`.
 */
export const AUDIT_ROUTES: Routes = [
  {
    path: '',
    component: PortalPlaceholderComponent,
    data: { titleKey: 'portal.audit.title' },
  },
];
