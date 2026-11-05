import type { Routes } from '@angular/router';
import { PortalPlaceholderComponent } from '../portal-placeholder.component';

/**
 * `/portal/team` (Req 1.5–1.7): members, roles, invitations — task 14.8 replaces the placeholder.
 * Inherits `access: member:manage`.
 */
export const TEAM_ROUTES: Routes = [
  {
    path: '',
    component: PortalPlaceholderComponent,
    data: { titleKey: 'portal.team.title' },
  },
];
