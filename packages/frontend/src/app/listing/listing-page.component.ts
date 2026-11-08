import { ChangeDetectionStrategy, Component, effect, inject, input, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { ApiClientService } from '../api/api-client.service';
import { ListingDetailComponent } from './listing-detail.component';
import { ListingManageComponent } from './listing-manage.component';
import { toListingPageState, type ListingPageState } from './listing-page-model';

/**
 * Public detail route `/listings/:id` (Öffentliche_Detail_URL, Req 4.19): loads the listing via
 * Search_API and shows the existing ListingDetailComponent. Unknown and not public listings show
 * the same "not found" view; Search_API does not tell them apart.
 */
@Component({
  selector: 'oe-listing-page',
  imports: [ListingDetailComponent, ListingManageComponent, RouterLink, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let s = state();
    @if (s.kind === 'found') {
      <oe-listing-manage [listing]="s.listing" />
      <oe-listing-detail [listing]="s.listing" (close)="toSearch()" />
    } @else if (s.kind === 'loading') {
      <p class="notice glass" role="status">{{ 'listingPage.loading' | transloco }}</p>
    } @else if (s.kind === 'not-found') {
      <section class="notice glass" role="alert" aria-labelledby="listing-not-found">
        <h1 id="listing-not-found" class="display">
          {{ 'listingPage.notFound.title' | transloco }}
        </h1>
        <p>{{ 'listingPage.notFound.message' | transloco }}</p>
        <a routerLink="/">{{ 'listingPage.toSearch' | transloco }}</a>
      </section>
    } @else {
      <section class="notice glass" role="alert">
        <p>{{ s.message.key | transloco: s.message.params }}</p>
        <button type="button" class="pill" (click)="retry()">
          {{ 'listingPage.retry' | transloco }}
        </button>
        <a routerLink="/">{{ 'listingPage.toSearch' | transloco }}</a>
      </section>
    }
  `,
  styles: `
    :host {
      display: block;
    }
    .notice {
      display: grid;
      gap: 0.75rem;
      justify-items: start;
      padding: 1.25rem 1.5rem;
    }
    h1,
    p {
      margin: 0;
    }
    a {
      color: var(--color-accent);
    }
  `,
})
export class ListingPageComponent {
  private readonly api = inject(ApiClientService);
  private readonly router = inject(Router);

  /** Route parameter `:id` (component input binding). */
  readonly id = input.required<string>();

  protected readonly state = signal<ListingPageState>({ kind: 'loading' });
  private readonly attempt = signal(0);

  constructor() {
    // Reload on a new id or a retry; a superseded request is cancelled.
    effect((onCleanup) => {
      const id = this.id();
      this.attempt();
      const controller = new AbortController();
      onCleanup(() => controller.abort());
      this.state.set({ kind: 'loading' });
      void this.api.getListing(id, { signal: controller.signal }).then((result) => {
        const next = toListingPageState(result);
        if (next && !controller.signal.aborted) this.state.set(next);
      });
    });
  }

  protected retry(): void {
    this.attempt.update((n) => n + 1);
  }

  protected toSearch(): void {
    void this.router.navigateByUrl('/');
  }
}
