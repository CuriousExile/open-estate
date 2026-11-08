import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { ADMIN_STYLES } from './admin-styles';

const AREAS = [
  { path: 'agencies', labelKey: 'portal.admin.agencies' },
  { path: 'listings', labelKey: 'portal.admin.listings' },
  { path: 'duplicates', labelKey: 'portal.admin.duplicates' },
  { path: 'monitoring', labelKey: 'portal.admin.monitoring' },
  { path: 'operations', labelKey: 'portal.admin.operations' },
  { path: 'audit', labelKey: 'portal.admin.audit' },
] as const;

/** Frame of the Admin_Modus (only `PLATFORM_ADMIN`, Req 10.1): area navigation. */
@Component({
  selector: 'oe-admin-shell',
  imports: [RouterLink, RouterLinkActive, RouterOutlet, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <nav class="glass card" [attr.aria-label]="'portal.admin.nav' | transloco">
      <ul class="subnav">
        @for (area of areas; track area.path) {
          <li>
            <a [routerLink]="area.path" routerLinkActive="active" ariaCurrentWhenActive="page">{{
              area.labelKey | transloco
            }}</a>
          </li>
        }
      </ul>
    </nav>
    <router-outlet />
  `,
  styles: [ADMIN_STYLES],
})
export class AdminShellComponent {
  protected readonly areas = AREAS;
}
