import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  Injectable,
  input,
} from '@angular/core';
import { DomSanitizer } from '@angular/platform-browser';
import { TranslocoPipe } from '@jsverse/transloco';
import type { LocalizedListing } from '@open-estate/shared';
import { StartupState } from '../startup/startup-state';
import {
  createTourRejectionReporter,
  planTourEmbeds,
  toAllowedTourHosts,
} from './tour-embed-model';

/** App-wide, so a hidden tour is logged once per listing and host — not on every reopen. */
@Injectable({ providedIn: 'root' })
export class TourRejectionLog {
  readonly report = createTourRejectionReporter((message, fields) =>
    console.warn(`[tours] ${message}`, fields),
  );
}

/**
 * 3D tours of a listing (design: TourEmbedComponent; Req 16.6, 16.7). Only tours whose host is in
 * `/meta.tourProviders` at display time are embedded; all others are hidden and logged with
 * listing ID and host. Renders nothing if no tour may be embedded.
 *
 * iframe hardening (CloudFront CSP `frame-src` from the allowlist is the second layer, task 16.17):
 * - `sandbox="allow-scripts allow-same-origin allow-popups"`: tour viewers are script/WebGL apps
 *   that call their own origin's API and storage, so they need scripts and their real origin. Both
 *   together are safe here because the frame is always cross-origin to the SPA (allowlisted
 *   third-party host), so it cannot reach the parent. `allow-popups` keeps provider links ("open in
 *   new tab") working; the popups stay sandboxed. Deliberately absent: `allow-top-navigation*`,
 *   `allow-forms`, `allow-modals`, `allow-popups-to-escape-sandbox`, `allow-downloads`.
 * - `allow`: fullscreen and the motion/XR features used by VR mode, delegated only to the frame's
 *   own origin.
 * - `referrerpolicy="no-referrer"`: the provider does not learn which listing page embeds it.
 */
@Component({
  selector: 'oe-tour-embed',
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let list = embeds();
    @if (list.length > 0) {
      <section aria-labelledby="detail-tours">
        <h3 id="detail-tours" class="label">{{ 'detail.tours.heading' | transloco }}</h3>
        <ul>
          @for (tour of list; track tour.index; let i = $index) {
            <li>
              <iframe
                sandbox="allow-scripts allow-same-origin allow-popups"
                allow="fullscreen; xr-spatial-tracking; gyroscope; accelerometer"
                allowfullscreen
                loading="lazy"
                referrerpolicy="no-referrer"
                [title]="
                  'detail.tours.frameTitle'
                    | transloco: { title: title(), position: i + 1, count: list.length }
                "
                [src]="tour.src"
              ></iframe>
            </li>
          }
        </ul>
      </section>
    }
  `,
  styles: `
    :host {
      display: block;
    }
    section {
      display: grid;
      gap: 0.75rem;
    }
    h3 {
      margin: 0;
    }
    ul {
      display: grid;
      gap: 0.75rem;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    iframe {
      display: block;
      width: 100%;
      aspect-ratio: 16 / 9;
      border: 1px solid var(--color-surface-border);
      border-radius: var(--radius-card);
      background: var(--color-surface);
    }
  `,
})
export class TourEmbedComponent {
  private readonly sanitizer = inject(DomSanitizer);
  private readonly startup = inject(StartupState);
  private readonly rejectionLog = inject(TourRejectionLog);

  readonly listingId = input.required<string>();
  readonly tours = input.required<LocalizedListing['tours']>();
  /** Listing title, for the accessible frame title. */
  readonly title = input.required<string>();

  private readonly allowedHosts = computed(() =>
    toAllowedTourHosts(this.startup.meta().tourProviders),
  );

  private readonly plan = computed(() =>
    planTourEmbeds(this.listingId(), this.tours(), this.allowedHosts()),
  );

  /** Only URLs that passed the host check are marked as trusted resource URLs. */
  protected readonly embeds = computed(() =>
    this.plan().embeds.map((tour) => ({
      ...tour,
      src: this.sanitizer.bypassSecurityTrustResourceUrl(tour.url),
    })),
  );

  constructor() {
    effect(() => this.rejectionLog.report(this.plan().rejections));
  }
}
