import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { PortalAuth } from '../auth/portal-auth.service';

/** Reasons shown by the notice routes; anything else falls back to `notConfigured`. */
const REASONS = ['notConfigured', 'loginFailed', 'session', 'forbidden'] as const;
type Reason = (typeof REASONS)[number];

const isReason = (value: string | undefined): value is Reason =>
  (REASONS as readonly (string | undefined)[]).includes(value);

/**
 * `/portal/unavailable` (not configured, login failed, `/me` failed) and `/portal/forbidden`
 * (missing permission). Sits outside the guards so it never loops back into the login.
 */
@Component({
  selector: 'oe-portal-notice',
  imports: [RouterLink, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let r = reason();
    <section class="notice glass" role="alert" aria-labelledby="portal-notice-title">
      <h1 id="portal-notice-title" class="label">
        {{ 'portal.notice.' + r + '.title' | transloco }}
      </h1>
      <p>{{ 'portal.notice.' + r + '.message' | transloco }}</p>
      <div class="actions">
        @if (r === 'forbidden') {
          <a routerLink="/portal">{{ 'portal.notice.toPortal' | transloco }}</a>
        } @else if (r !== 'notConfigured') {
          <a routerLink="/portal">{{ 'portal.notice.retry' | transloco }}</a>
          <button type="button" class="pill" (click)="logout()">
            {{ 'portal.logout' | transloco }}
          </button>
        }
        <a routerLink="/">{{ 'portal.notice.toSearch' | transloco }}</a>
      </div>
    </section>
  `,
  styles: `
    .notice {
      display: grid;
      gap: 0.75rem;
      padding: 1.25rem 1.5rem;
    }
    h1,
    p {
      margin: 0;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 1rem;
      align-items: center;
    }
    a {
      color: var(--brand-secondary);
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
export class PortalNoticeComponent {
  private readonly auth = inject(PortalAuth);

  /** Query parameter `reason`, or the route data `reason` of `/portal/forbidden`. */
  readonly reasonParam = input<string | undefined>(undefined, { alias: 'reason' });

  protected readonly reason = computed<Reason>(() => {
    const value = this.reasonParam();
    return isReason(value) ? value : 'notConfigured';
  });

  protected logout(): void {
    this.auth.logout();
  }
}
