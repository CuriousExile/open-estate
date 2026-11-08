import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { ListingView, type LocalizedListing } from '@open-estate/shared';
import { PortalPresence } from '../auth/portal-presence.service';
import { ManagementApiClient } from '../management/management-api-client.service';
import {
  isVersionConflict,
  nextStatus,
  setListingStatus,
  statusChangedKey,
  toggleLabelKey,
  type ManagedListing,
} from '../portal/shared/listing-status';
import { manageRights, worthAsking } from './listing-manage-model';

type Message = { readonly key: string; readonly params: Readonly<Record<string, string>> };

/**
 * Manage bar above the public detail view, for users signed in to the portal in this tab who may
 * manage the listing (own agency; Plattform_Admins: all): status, "Edit listing", "Deactivate" /
 * "Activate" and a link to the portal workspace. Shown only after the Management_API returned the
 * listing for this user; anonymous visitors and other agencies see nothing. A status change is
 * reported through `statusChange`, so the search's result card can follow.
 */
@Component({
  selector: 'oe-listing-manage',
  imports: [RouterLink, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (managed(); as m) {
      <section class="manage glass" aria-labelledby="listing-manage-title">
        <h2 id="listing-manage-title" class="label">{{ 'listingManage.title' | transloco }}</h2>
        <p class="state" [class.inactive]="m.status !== 'ACTIVE'">
          {{ 'listingManage.state.' + m.status | transloco }}
        </p>
        <div class="actions">
          @if (rights().status) {
            <button type="button" class="pill primary" [disabled]="busy()" (click)="toggle()">
              {{ (busy() ? 'portal.status.saving' : toggleLabel(m.status)) | transloco }}
            </button>
          }
          @if (rights().edit) {
            <a class="pill" [routerLink]="['/portal/listings', m.id, 'edit']">
              {{ 'portal.workspace.edit' | transloco }}
            </a>
          }
          <a class="pill" [routerLink]="['/portal/listings', m.id]">
            {{ 'listingManage.open' | transloco }}
          </a>
        </div>
        <p role="status" class="notice">
          @if (notice(); as n) {
            {{ n.key | transloco: n.params }}
          }
        </p>
        @if (error(); as message) {
          <p role="alert" class="error">{{ message }}</p>
        }
      </section>
    }
  `,
  styles: `
    .manage {
      display: grid;
      gap: 0.6rem;
      margin-bottom: 1rem;
      padding: 1rem 1.5rem;
    }
    h2,
    p {
      margin: 0;
    }
    .state.inactive,
    .error {
      color: var(--color-error);
    }
    .notice:empty {
      display: none;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
    }
    .pill {
      padding: 0.4rem 1.1rem;
      border: 1px solid var(--color-surface-border);
      border-radius: var(--radius-pill);
      background: transparent;
      color: inherit;
      font: inherit;
      text-decoration: none;
      cursor: pointer;
    }
    .primary {
      border-color: var(--color-accent);
      background: var(--color-accent);
      color: var(--color-on-accent);
    }
  `,
})
export class ListingManageComponent {
  private readonly presence = inject(PortalPresence);
  private readonly api = inject(ManagementApiClient);

  /** The public listing shown below. */
  readonly listing = input.required<LocalizedListing>();
  /** After a successful (de)activation, with the new state of the listing. */
  readonly statusChange = output<ManagedListing>();

  protected readonly managed = signal<ManagedListing | undefined>(undefined);
  protected readonly rights = computed(() => manageRights(this.presence.me()));
  protected readonly busy = signal(false);
  protected readonly notice = signal<Message | undefined>(undefined);
  protected readonly error = signal<string | undefined>(undefined);
  protected readonly toggleLabel = toggleLabelKey;

  constructor() {
    effect((onCleanup) => {
      const listing = this.listing();
      const controller = new AbortController();
      onCleanup(() => controller.abort());
      untracked(() => {
        this.managed.set(undefined);
        this.notice.set(undefined);
        this.error.set(undefined);
        void this.load(listing, controller.signal);
      });
    });
  }

  protected async toggle(): Promise<void> {
    const current = this.managed();
    if (current === undefined || this.busy()) return;
    this.busy.set(true);
    this.error.set(undefined);
    const status = nextStatus(current.status);
    const result = await setListingStatus(this.api, current.id, status, current.version);
    this.busy.set(false);
    if (result.ok) {
      this.managed.set(result.value);
      this.notice.set({
        key: statusChangedKey(result.value.status),
        params: { title: result.value.content.title },
      });
      this.statusChange.emit(result.value);
      return;
    }
    this.error.set(this.api.errorMessage(result.error));
    // Changed in the meantime: show the current state, the user decides again.
    if (isVersionConflict(result.error)) await this.reload(current.id);
  }

  private async load(listing: LocalizedListing, signal: AbortSignal): Promise<void> {
    if (!(await this.presence.signedIn()) || signal.aborted) return;
    if (!worthAsking(this.presence.me(), listing)) return;
    const result = await this.api.get(`/listings/${encodeURIComponent(listing.id)}`, {
      signal,
      parse: (value) => ListingView.parse(value),
    });
    // Not the user's listing (404) or not reachable: no bar, the public view stays as it is.
    if (!signal.aborted && result.ok) this.managed.set(result.value);
  }

  private async reload(id: string): Promise<void> {
    const result = await this.api.get(`/listings/${encodeURIComponent(id)}`, {
      parse: (value) => ListingView.parse(value),
    });
    if (result.ok) this.managed.set(result.value);
  }
}
