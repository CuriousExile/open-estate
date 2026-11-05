import type { Routes } from '@angular/router';
import { TeamComponent } from './team.component';

/** `/portal/team` (Req 1.5–1.7): members, roles, invitations. Inherits `access: member:manage`. */
export const TEAM_ROUTES: Routes = [{ path: '', component: TeamComponent }];
