import type { Routes } from '@angular/router';
import { MachineAccessComponent } from './machine-access.component';

/**
 * `/portal/machine-access` (Req 3.1, 3.5, 3.7). Inherits `access: machine-access:manage`.
 */
export const MACHINE_ACCESS_ROUTES: Routes = [{ path: '', component: MachineAccessComponent }];
