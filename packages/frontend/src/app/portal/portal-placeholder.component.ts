import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';

/**
 * Stand-in for a portal area that is not built yet; each area's `*.routes.ts` replaces it with
 * the real component (tasks 14.3–14.9). `titleKey` comes from the route data.
 */
@Component({
  selector: 'oe-portal-placeholder',
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="glass placeholder" aria-labelledby="portal-placeholder-title">
      <h1 id="portal-placeholder-title" class="label">{{ titleKey() | transloco }}</h1>
      <p>{{ 'portal.placeholder.message' | transloco }}</p>
    </section>
  `,
  styles: `
    .placeholder {
      padding: 1.25rem 1.5rem;
    }
    h1,
    p {
      margin: 0;
    }
    p {
      margin-top: 0.5rem;
      color: var(--color-text-muted);
    }
  `,
})
export class PortalPlaceholderComponent {
  readonly titleKey = input.required<string>();
}
