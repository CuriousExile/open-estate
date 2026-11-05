import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { PortalAuth } from '../auth/portal-auth.service';
import { PortalSession } from '../auth/portal-session.service';

/**
 * Frame of the Agentur_Portal and Admin_Modus: navigation limited to the areas the user may use
 * (Req 5.6), current user, logout.
 */
@Component({
  selector: 'oe-portal-shell',
  imports: [RouterLink, RouterLinkActive, RouterOutlet, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="portal">
      <nav class="portal-nav glass" [attr.aria-label]="'portal.nav.label' | transloco">
        <ul>
          @for (item of session.navItems(); track item.path) {
            <li>
              <a [routerLink]="item.path" routerLinkActive="active" ariaCurrentWhenActive="page">
                {{ item.labelKey | transloco }}
              </a>
            </li>
          }
        </ul>
        <div class="portal-user">
          @if (session.me(); as me) {
            <span class="label">{{ me.displayName }}</span>
          }
          <button type="button" class="pill" (click)="logout()">
            {{ 'portal.logout' | transloco }}
          </button>
        </div>
      </nav>
      <section class="portal-content">
        <router-outlet />
      </section>
    </div>
  `,
  styles: `
    .portal {
      display: grid;
      gap: 1.5rem;
    }
    .portal-nav {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: center;
      gap: 1rem;
      padding: 0.75rem 1.25rem;
    }
    ul {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem 1.25rem;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    a {
      color: var(--color-text-muted);
      text-decoration: none;
    }
    a.active,
    a:hover {
      color: var(--brand-secondary);
    }
    .portal-user {
      display: flex;
      align-items: center;
      gap: 1rem;
    }
    .pill {
      padding: 0.4rem 1.1rem;
      border: 1px solid var(--color-surface-border);
      border-radius: var(--radius-pill);
      background: transparent;
      color: inherit;
      font: inherit;
      cursor: pointer;
    }
  `,
})
export class PortalShellComponent {
  protected readonly session = inject(PortalSession);
  private readonly auth = inject(PortalAuth);

  constructor() {
    // The permission guard loads /me for guarded areas; this covers routes without `access`.
    void this.session.load();
  }

  protected logout(): void {
    this.auth.logout();
  }
}
