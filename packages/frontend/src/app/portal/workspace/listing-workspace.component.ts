import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import {
  DiffResponse,
  ListingView,
  MANAGEMENT_BOUNDS,
  VersionDetail,
  VersionPage,
} from '@open-estate/shared';
import { PortalSession } from '../../auth/portal-session.service';
import { formatDateTime } from '../../listing/listing-detail-model';
import { ListingDetailComponent } from '../../listing/listing-detail.component';
import { LocaleService } from '../../locale/locale.service';
import { ManagementApiClient } from '../../management/management-api-client.service';
import type { ManagementError } from '../../management/management-client';
import { StartupState } from '../../startup/startup-state';
import { FieldProvenanceComponent } from './field-provenance.component';
import { fieldProvenanceRows, missingImportVersions } from './field-provenance-model';
import { RestoreDialogComponent, type RestoreDialogState } from './restore-dialog.component';
import { restoreDiffRows, toDiffRows, type DiffRow } from './version-diff-model';
import { VersionDiffComponent } from './version-diff.component';
import {
  comparePair,
  mergeVersionPages,
  toggleCompare,
  toTimelineItem,
} from './version-timeline-model';
import { VersionTimelineComponent } from './version-timeline.component';
import {
  originKey,
  statusKey,
  toPublicDetailModel,
  WORKSPACE_TABS,
  type ParsedListingView,
  type ParsedVersionEntry,
  type WorkspaceTab,
} from './workspace-model';

type ListingState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly view: ParsedListingView }
  /** `notAvailable`: 403/404 — no resource data is shown (Req 2.5, 2.6). */
  | { readonly kind: 'failed'; readonly message: string; readonly notAvailable: boolean };

type CompareState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading'; readonly from: number; readonly to: number }
  | { readonly kind: 'ready'; readonly from: number; readonly to: number; readonly rows: DiffRow[] }
  | { readonly kind: 'failed'; readonly message: string };

interface RestoreState {
  readonly version: number;
  readonly dialog: RestoreDialogState;
  readonly busy: boolean;
  readonly errorMessage?: string;
  readonly fieldErrors: readonly string[];
}

const TAB_KEYS: Record<WorkspaceTab, string> = {
  preview: 'portal.workspace.tab.preview',
  provenance: 'portal.workspace.tab.provenance',
  history: 'portal.workspace.tab.history',
};

/**
 * `/portal/listings/:id` (design: ListingWorkspaceComponent; Req 5.8, 7.8, 8.6, 12.15): header with
 * Herkunft and state, tabs for the public preview (the unchanged `ListingDetailComponent` fed by
 * `toPublicDetailModel`), the Feldherkunft of every Inhaltsfeld and the version history with diff
 * of two versions and restore (diff + confirmation).
 */
@Component({
  selector: 'oe-listing-workspace',
  imports: [
    FieldProvenanceComponent,
    ListingDetailComponent,
    RestoreDialogComponent,
    RouterLink,
    TranslocoPipe,
    VersionDiffComponent,
    VersionTimelineComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let s = state();
    @if (s.kind === 'loading') {
      <p class="glass notice" role="status">{{ 'portal.workspace.loading' | transloco }}</p>
    } @else if (s.kind === 'failed') {
      <section class="glass notice" role="alert">
        @if (s.notAvailable) {
          <h1 class="display">{{ 'portal.workspace.notAvailable.title' | transloco }}</h1>
          <p>{{ 'portal.workspace.notAvailable.message' | transloco }}</p>
        } @else {
          <p>{{ s.message }}</p>
          <button type="button" class="pill" (click)="reload()">
            {{ 'portal.workspace.retry' | transloco }}
          </button>
        }
        <a routerLink="/portal/listings">{{ 'portal.workspace.toListings' | transloco }}</a>
      </section>
    } @else {
      @let view = s.view;
      <header class="glass head">
        <a routerLink="/portal/listings">{{ 'portal.workspace.toListings' | transloco }}</a>
        <h1 class="display" [attr.lang]="view.content.originalLocale">{{ view.content.title }}</h1>
        <dl>
          <dt class="label">{{ 'portal.workspace.meta.status' | transloco }}</dt>
          <dd>{{ statusKey(view.status) | transloco }}</dd>
          <dt class="label">{{ 'portal.workspace.meta.origin' | transloco }}</dt>
          <dd>{{ originKey(view.origin) | transloco }}</dd>
          <dt class="label">{{ 'portal.workspace.meta.source' | transloco }}</dt>
          <dd>{{ view.source }}</dd>
          @if (view.customId !== undefined) {
            <dt class="label">{{ 'portal.workspace.meta.customId' | transloco }}</dt>
            <dd>{{ view.customId }}</dd>
          }
          <dt class="label">{{ 'portal.workspace.meta.version' | transloco }}</dt>
          <dd>{{ view.version }}</dd>
          <dt class="label">{{ 'portal.workspace.meta.updatedAt' | transloco }}</dt>
          <dd>{{ formatDateTime(view.updatedAt, locale.active()) }}</dd>
        </dl>
        @if (session.can('listing:write')) {
          <a class="pill" routerLink="edit">{{ 'portal.workspace.edit' | transloco }}</a>
        }
      </header>

      @if (notice(); as noticeKey) {
        <p class="glass notice" role="status">
          {{ noticeKey | transloco: { version: view.version } }}
        </p>
      }

      <div class="tabs" role="tablist" [attr.aria-label]="'portal.workspace.tabs' | transloco">
        @for (t of tabs; track t) {
          <button
            type="button"
            role="tab"
            class="tab"
            [id]="'workspace-tab-' + t"
            [attr.aria-controls]="'workspace-panel-' + t"
            [attr.aria-selected]="tab() === t"
            [attr.tabindex]="tab() === t ? 0 : -1"
            (click)="tab.set(t)"
            (keydown.arrowRight)="moveTab(1)"
            (keydown.arrowLeft)="moveTab(-1)"
          >
            {{ tabKeys[t] | transloco }}
          </button>
        }
      </div>

      <section
        class="panel"
        role="tabpanel"
        [id]="'workspace-panel-' + tab()"
        [attr.aria-labelledby]="'workspace-tab-' + tab()"
      >
        @switch (tab()) {
          @case ('preview') {
            @if (view.status !== 'ACTIVE') {
              <p class="glass notice">{{ 'portal.workspace.preview.inactive' | transloco }}</p>
            }
            @if (preview(); as listing) {
              <oe-listing-detail [listing]="listing" (close)="toListings()" />
            }
          }
          @case ('provenance') {
            <div class="glass card">
              <p class="muted">{{ 'portal.workspace.provenance.intro' | transloco }}</p>
              @if (historyError(); as message) {
                <p role="alert" class="error">{{ message }}</p>
              }
              <oe-field-provenance [rows]="provenance()" />
            </div>
          }
          @case ('history') {
            <div class="glass card">
              <h2 class="label">{{ 'portal.workspace.compare.title' | transloco }}</h2>
              @let c = compare();
              @if (c.kind === 'idle') {
                <p class="muted">{{ 'portal.workspace.compare.hint' | transloco }}</p>
              } @else if (c.kind === 'loading') {
                <p role="status">{{ 'portal.workspace.compare.loading' | transloco }}</p>
              } @else if (c.kind === 'failed') {
                <p role="alert" class="error">{{ c.message }}</p>
              } @else {
                <p>
                  {{ 'portal.workspace.compare.range' | transloco: { from: c.from, to: c.to } }}
                </p>
                <oe-version-diff [rows]="c.rows" />
              }
            </div>
            @if (historyError(); as message) {
              <p role="alert" class="glass notice error">{{ message }}</p>
            }
            <oe-version-timeline
              [items]="timeline()"
              [selected]="selected()"
              [mayRestore]="session.can('version:restore')"
              [hasMore]="nextPageToken() !== undefined"
              [loadingMore]="historyLoading()"
              [locale]="locale.active()"
              (toggleCompare)="selected.set(toggleCompare(selected(), $event))"
              (restore)="openRestore($event)"
              (loadMore)="loadMoreVersions()"
            />
          }
        }
      </section>

      @if (restore(); as r) {
        <oe-restore-dialog
          [version]="r.version"
          [currentVersion]="view.version"
          [state]="r.dialog"
          [busy]="r.busy"
          [errorMessage]="r.errorMessage"
          [fieldErrors]="r.fieldErrors"
          (confirm)="confirmRestore()"
          (cancel)="restore.set(undefined)"
        />
      }
    }
  `,
  styles: `
    :host {
      display: grid;
      gap: 1rem;
    }
    h1,
    h2,
    p,
    dl,
    dd {
      margin: 0;
    }
    .notice,
    .card,
    .head {
      display: grid;
      gap: 0.75rem;
      justify-items: start;
      padding: 1.25rem 1.5rem;
    }
    .card {
      justify-items: stretch;
    }
    dl {
      display: flex;
      flex-wrap: wrap;
      gap: 0.25rem 0.75rem;
      align-items: baseline;
    }
    dd + dt {
      margin-left: 0.75rem;
    }
    .tabs {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
    }
    .tab,
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
    .tab[aria-selected='true'] {
      border-color: var(--brand-secondary);
      color: var(--brand-secondary);
    }
    .panel {
      display: grid;
      gap: 1rem;
    }
    .muted {
      color: var(--color-text-muted);
    }
    .error {
      color: var(--color-error-strong);
    }
    a {
      color: var(--brand-secondary);
    }
  `,
})
export class ListingWorkspaceComponent {
  private readonly api = inject(ManagementApiClient);
  private readonly router = inject(Router);
  private readonly startup = inject(StartupState);
  private readonly document = inject(DOCUMENT);
  protected readonly session = inject(PortalSession);
  protected readonly locale = inject(LocaleService);

  /** Route parameter `:id` of the parent route (component input binding). */
  readonly id = input.required<string>();

  protected readonly tabs = WORKSPACE_TABS;
  protected readonly tabKeys = TAB_KEYS;
  protected readonly tab = signal<WorkspaceTab>('preview');
  protected readonly state = signal<ListingState>({ kind: 'loading' });
  protected readonly notice = signal<string | undefined>(undefined);

  private readonly versions = signal<ParsedVersionEntry[]>([]);
  /** Import versions loaded individually for the Feldherkunft (not on a loaded page). */
  private readonly extraVersions = signal<ReadonlyMap<number, ParsedVersionEntry>>(new Map());
  protected readonly nextPageToken = signal<string | undefined>(undefined);
  protected readonly historyLoading = signal(false);
  protected readonly historyError = signal<string | undefined>(undefined);

  protected readonly selected = signal<number[]>([]);
  protected readonly compare = signal<CompareState>({ kind: 'idle' });
  protected readonly restore = signal<RestoreState | undefined>(undefined);

  private readonly reloads = signal(0);
  /** Cancels the requests of a superseded listing (new id or reload). */
  private controller = new AbortController();

  private readonly view = computed(() => {
    const s = this.state();
    return s.kind === 'ready' ? s.view : undefined;
  });

  /** Same model the public detail view gets for this listing with status `ACTIVE` (Req 5.8). */
  protected readonly preview = computed(() => {
    const view = this.view();
    if (!view) return undefined;
    const taxonomy = this.startup.meta().taxonomy ?? { groups: [] };
    return toPublicDetailModel(view, this.locale.active(), taxonomy);
  });

  private readonly history = computed(() => {
    const map = new Map(this.extraVersions());
    for (const entry of this.versions()) map.set(entry.version, entry);
    return map;
  });

  protected readonly provenance = computed(() => {
    const view = this.view();
    return view ? fieldProvenanceRows(view, this.history()) : [];
  });

  protected readonly timeline = computed(() => {
    const current = this.view()?.version ?? 0;
    return this.versions().map((entry) => toTimelineItem(entry, current));
  });

  protected readonly statusKey = statusKey;
  protected readonly originKey = originKey;
  protected readonly formatDateTime = formatDateTime;
  protected readonly toggleCompare = toggleCompare;

  constructor() {
    effect((onCleanup) => {
      const id = this.id();
      this.reloads();
      const controller = new AbortController();
      this.controller = controller;
      onCleanup(() => controller.abort());
      untracked(() => void this.loadAll(id, controller.signal));
    });

    // Diff of the two selected versions, from the older to the newer (Req 7.6, 7.8).
    effect((onCleanup) => {
      const pair = comparePair(this.selected());
      if (!pair) {
        this.compare.set({ kind: 'idle' });
        return;
      }
      const controller = new AbortController();
      onCleanup(() => controller.abort());
      this.compare.set({ kind: 'loading', ...pair });
      const id = untracked(() => this.id());
      void this.fetchDiff(id, pair.from, pair.to, controller.signal).then((result) => {
        if (controller.signal.aborted || result === undefined) return;
        this.compare.set(
          result.ok
            ? { kind: 'ready', ...pair, rows: toDiffRows(result.value.entries) }
            : { kind: 'failed', message: result.message },
        );
      });
    });
  }

  protected reload(): void {
    this.reloads.update((n) => n + 1);
  }

  protected toListings(): void {
    void this.router.navigateByUrl('/portal/listings');
  }

  protected moveTab(step: number): void {
    const index = WORKSPACE_TABS.indexOf(this.tab());
    const next = WORKSPACE_TABS[(index + step + WORKSPACE_TABS.length) % WORKSPACE_TABS.length];
    if (next === undefined) return;
    this.tab.set(next);
    this.document.getElementById(`workspace-tab-${next}`)?.focus();
  }

  protected loadMoreVersions(): void {
    const token = this.nextPageToken();
    if (token === undefined || this.historyLoading()) return;
    void this.loadVersions(this.id(), token, this.controller.signal);
  }

  /** Opens the confirmation with the Diff from the current version to `version` (Req 8.6). */
  protected openRestore(version: number, errorMessage?: string): void {
    const current = this.view()?.version;
    if (current === undefined) return;
    this.restore.set({
      version,
      dialog: { kind: 'loading' },
      busy: false,
      fieldErrors: [],
      ...(errorMessage !== undefined && { errorMessage }),
    });
    const signal = this.controller.signal;
    void this.fetchDiff(this.id(), current, version, signal).then((result) => {
      if (signal.aborted || result === undefined) return;
      this.restore.update((r) =>
        r?.version === version
          ? {
              ...r,
              dialog: result.ok
                ? { kind: 'ready', rows: restoreDiffRows(result.value.entries) }
                : { kind: 'failed', message: result.message },
            }
          : r,
      );
    });
  }

  /** `POST /listings/{id}/restore` with the current version as Bezugsversion (Req 8.1, 8.5). */
  protected async confirmRestore(): Promise<void> {
    const r = this.restore();
    const view = this.view();
    if (!r || r.busy || !view) return;
    this.restore.set({ ...r, busy: true, fieldErrors: [] });
    const id = this.id();
    const result = await this.api.post(
      `/listings/${encodeURIComponent(id)}/restore`,
      { version: r.version, baseVersion: view.version },
      { parse: (value) => ListingView.parse(value) },
    );
    if (result.ok) {
      this.restore.set(undefined);
      this.state.set({ kind: 'ready', view: result.value });
      this.notice.set('portal.workspace.restore.done');
      this.selected.set([]);
      void this.loadVersions(id, undefined, this.controller.signal);
      return;
    }
    const message = this.message(result.error);
    if (message === undefined) return;
    if (isConflict(result.error)) {
      // Changed in the meantime (Req 8.5): reload, then show the diff against the new version.
      const loaded = await this.loadListing(id, this.controller.signal);
      void this.loadVersions(id, undefined, this.controller.signal);
      if (loaded) this.openRestore(r.version, message);
      else this.restore.set({ ...r, busy: false, errorMessage: message });
      return;
    }
    const fieldErrors =
      result.error.kind === 'api'
        ? result.error.errors.map((e) => (e.field !== undefined ? e.field : e.message))
        : [];
    this.restore.set({ ...r, busy: false, errorMessage: message, fieldErrors });
  }

  private async loadAll(id: string, signal: AbortSignal): Promise<void> {
    this.state.set({ kind: 'loading' });
    this.notice.set(undefined);
    this.versions.set([]);
    this.extraVersions.set(new Map());
    this.nextPageToken.set(undefined);
    this.historyError.set(undefined);
    this.selected.set([]);
    this.restore.set(undefined);
    if (!(await this.loadListing(id, signal))) return;
    await this.loadVersions(id, undefined, signal);
  }

  /** Loads the listing; `true` on success. */
  private async loadListing(id: string, signal: AbortSignal): Promise<boolean> {
    const result = await this.api.get(`/listings/${encodeURIComponent(id)}`, {
      signal,
      parse: (value) => ListingView.parse(value),
    });
    if (signal.aborted) return false;
    if (result.ok) {
      this.state.set({ kind: 'ready', view: result.value });
      return true;
    }
    const message = this.message(result.error);
    if (message !== undefined) {
      this.state.set({ kind: 'failed', message, notAvailable: isNotAvailable(result.error) });
    }
    return false;
  }

  /** First page (`pageToken` undefined, replaces the shown versions) or a further page. */
  private async loadVersions(
    id: string,
    pageToken: string | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    this.historyLoading.set(true);
    const result = await this.api.get(`/listings/${encodeURIComponent(id)}/versions`, {
      signal,
      query: { pageSize: MANAGEMENT_BOUNDS.pageSize.default, pageToken },
      parse: (value) => VersionPage.parse(value),
    });
    if (signal.aborted) return;
    this.historyLoading.set(false);
    if (!result.ok) {
      this.historyError.set(this.message(result.error));
      return;
    }
    this.historyError.set(undefined);
    this.versions.set(
      pageToken === undefined
        ? result.value.items
        : mergeVersionPages(this.versions(), result.value.items),
    );
    this.nextPageToken.set(result.value.nextPageToken);
    await this.loadMissingImportVersions(id, signal);
  }

  /** Import versions of the Feldherkunft that are not on a loaded page (Req 12.15 highlighting). */
  private async loadMissingImportVersions(id: string, signal: AbortSignal): Promise<void> {
    const view = this.view();
    if (!view) return;
    const missing = missingImportVersions(view.fieldSources, this.history());
    if (missing.length === 0) return;
    const results = await Promise.all(
      missing.map((n) =>
        this.api.get(`/listings/${encodeURIComponent(id)}/versions/${n}`, {
          signal,
          parse: (value) => VersionDetail.parse(value),
        }),
      ),
    );
    if (signal.aborted) return;
    const extra = new Map(this.extraVersions());
    for (const result of results) {
      if (result.ok) extra.set(result.value.version, result.value);
      else this.historyError.set(this.message(result.error));
    }
    this.extraVersions.set(extra);
  }

  private async fetchDiff(id: string, from: number, to: number, signal: AbortSignal) {
    const result = await this.api.get(`/listings/${encodeURIComponent(id)}/diff`, {
      signal,
      query: { from, to },
      parse: (value) => DiffResponse.parse(value),
    });
    if (result.ok) return result;
    const message = this.message(result.error);
    return message === undefined ? undefined : { ok: false as const, message };
  }

  private message(error: ManagementError): string | undefined {
    return this.api.errorMessage(error);
  }
}

function isNotAvailable(error: ManagementError): boolean {
  return error.kind === 'api' && (error.status === 403 || error.status === 404);
}

function isConflict(error: ManagementError): boolean {
  return error.kind === 'api' && error.status === 409;
}
