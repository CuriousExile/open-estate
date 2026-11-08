import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { LocaleService } from '../../locale/locale.service';
import { ManagementApiClient } from '../../management/management-api-client.service';
import type { ManagementError, ManagementResult } from '../../management/management-client';
import { formatTimestamp } from '../listings/listing-table-model';
import {
  addPlatformAdmin,
  createApiKey,
  getDeletion,
  getDuplicateDetection,
  listPlatformAdmins,
  previewDeletion,
  previewRemovePlatformAdmin,
  reload,
  removeBlocklistEntry,
  removePlatformAdmin,
  requestDeletion,
  revokeApiKey,
  setAccessMode,
  setApiKeyRateLimit,
  setDuplicateDetection,
  setRateLimit,
  type CreatedApiKeyValue,
  type DeletionRequestValue,
} from './admin-api';
import {
  ACCESS_MODES,
  apiKeyRequest,
  confirmation,
  deletionCriterion,
  disableDuplicateDetectionConfirmation,
  duplicateDetectionSwitched,
  parseRateLimit,
  reloadFailed,
  requiredId,
  toDuplicateDetectionState,
  validateEmail,
  type AccessMode,
  type Confirmation,
  type DeletionKind,
  type DuplicateDetectionState,
  type FieldResult,
  type ReloadOutcomeData,
  type TranslatedText,
} from './admin-model';
import { ADMIN_STYLES } from './admin-styles';
import { ConfirmDialogComponent } from './confirm-dialog.component';

/** Form sections of the view, each with its own feedback line. */
type Section =
  | 'deletion'
  | 'lookup'
  | 'blocklist'
  | 'apiKey'
  | 'revokeKey'
  | 'keyLimit'
  | 'rateLimit'
  | 'accessMode'
  | 'reload'
  | 'duplicates'
  | 'admins';

interface Feedback {
  error?: string;
  /** Translation key of a success message. */
  done?: string;
  /** Parameters of `done`. */
  params?: Readonly<Record<string, string | number>>;
}

interface PlatformAdminRow {
  userId: string;
  email: string;
  displayName: string;
}

interface Pending {
  confirmation: Confirmation;
  run: () => Promise<void>;
}

/**
 * `/portal/admin/operations` (Req 10.7, 10.8): the Admin_API's functions on `/platform/*` —
 * deletion requests, deletion blocklist, API keys, rate limits, access mode, Ein/Aus of the
 * Duplikat-Erkennung, reload — and the Plattform_Admin list. Destructive operations ask first; where the API offers `dryRun` the dialog
 * shows the affected listings or users of that preview.
 */
@Component({
  selector: 'oe-admin-operations',
  imports: [ConfirmDialogComponent, NgTemplateOutlet, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1 class="label">{{ 'portal.admin.operations' | transloco }}</h1>

    <section class="glass card" aria-labelledby="ops-deletion">
      <h2 id="ops-deletion">{{ 'portal.admin.ops.deletion.title' | transloco }}</h2>
      <p class="note">{{ 'portal.admin.ops.deletion.hint' | transloco }}</p>
      <form class="inline" (submit)="askDeletion($event)" novalidate>
        <label class="field">
          <span>{{ 'portal.admin.ops.deletion.kind' | transloco }}</span>
          <select [value]="deletionKind()" (change)="deletionKind.set(kindOf($event))">
            <option value="listingId">
              {{ 'portal.admin.ops.deletion.listingId' | transloco }}
            </option>
            <option value="source">{{ 'portal.admin.ops.deletion.source' | transloco }}</option>
          </select>
        </label>
        <label class="field">
          <span>{{ 'portal.admin.ops.deletion.value' | transloco }}</span>
          <input
            name="deletionValue"
            [value]="deletionValue()"
            [attr.aria-invalid]="feedback().deletion?.error ? 'true' : null"
            aria-describedby="ops-deletion-feedback"
            (input)="deletionValue.set(value($event))"
          />
        </label>
        <button type="submit" class="pill danger" [disabled]="busy()">
          {{ 'portal.admin.ops.deletion.action' | transloco }}
        </button>
      </form>
      <div id="ops-deletion-feedback">
        <ng-container
          *ngTemplateOutlet="feedbackTpl; context: { $implicit: feedback().deletion }"
        />
      </div>
      @if (deletionResult(); as r) {
        <ng-container *ngTemplateOutlet="requestTpl; context: { $implicit: r }" />
      }

      <h3>{{ 'portal.admin.ops.lookup.title' | transloco }}</h3>
      <form class="inline" (submit)="lookup($event)" novalidate>
        <label class="field">
          <span>{{ 'portal.admin.ops.lookup.requestId' | transloco }}</span>
          <input name="requestId" [value]="requestId()" (input)="requestId.set(value($event))" />
        </label>
        <button type="submit" class="pill" [disabled]="busy()">
          {{ 'portal.admin.ops.lookup.action' | transloco }}
        </button>
      </form>
      <ng-container *ngTemplateOutlet="feedbackTpl; context: { $implicit: feedback().lookup }" />
      @if (lookupResult(); as r) {
        <ng-container *ngTemplateOutlet="requestTpl; context: { $implicit: r }" />
      }
    </section>

    <section class="glass card" aria-labelledby="ops-blocklist">
      <h2 id="ops-blocklist">{{ 'portal.admin.ops.blocklist.title' | transloco }}</h2>
      <p class="note">{{ 'portal.admin.ops.blocklist.hint' | transloco }}</p>
      <form class="inline" (submit)="unblock($event)" novalidate>
        <label class="field">
          <span>{{ 'portal.admin.ops.deletion.listingId' | transloco }}</span>
          <input name="blockedId" [value]="blockedId()" (input)="blockedId.set(value($event))" />
        </label>
        <button type="submit" class="pill" [disabled]="busy()">
          {{ 'portal.admin.ops.blocklist.action' | transloco }}
        </button>
      </form>
      <ng-container *ngTemplateOutlet="feedbackTpl; context: { $implicit: feedback().blocklist }" />
    </section>

    <section class="glass card" aria-labelledby="ops-keys">
      <h2 id="ops-keys">{{ 'portal.admin.ops.apiKeys.title' | transloco }}</h2>
      <h3>{{ 'portal.admin.ops.apiKeys.create' | transloco }}</h3>
      <form class="inline" (submit)="createKey($event)" novalidate>
        <label class="field">
          <span>{{ 'portal.admin.ops.apiKeys.expiresAt' | transloco }}</span>
          <input
            type="datetime-local"
            name="expiresAt"
            [value]="keyForm().expiresAt"
            (input)="setKeyForm('expiresAt', $event)"
          />
        </label>
        <label class="field">
          <span>{{ 'portal.admin.ops.rateLimit.requests' | transloco }}</span>
          <input
            inputmode="numeric"
            name="keyRequests"
            [value]="keyForm().requests"
            (input)="setKeyForm('requests', $event)"
          />
        </label>
        <label class="field">
          <span>{{ 'portal.admin.ops.rateLimit.windowSeconds' | transloco }}</span>
          <input
            inputmode="numeric"
            name="keyWindow"
            [value]="keyForm().windowSeconds"
            (input)="setKeyForm('windowSeconds', $event)"
          />
        </label>
        <button type="submit" class="pill primary" [disabled]="busy()">
          {{ 'portal.admin.ops.apiKeys.createAction' | transloco }}
        </button>
      </form>
      <ng-container *ngTemplateOutlet="feedbackTpl; context: { $implicit: feedback().apiKey }" />
      @if (createdKey(); as key) {
        <div class="secret" role="status">
          <p>{{ 'portal.admin.ops.apiKeys.once' | transloco }}</p>
          <p>
            {{ 'portal.admin.ops.apiKeys.keyId' | transloco }}: <code>{{ key.keyId }}</code>
          </p>
          <p>
            {{ 'portal.admin.ops.apiKeys.key' | transloco }}: <code>{{ key.apiKey }}</code>
          </p>
          <button type="button" class="pill" (click)="createdKey.set(undefined)">
            {{ 'portal.admin.ops.apiKeys.hide' | transloco }}
          </button>
        </div>
      }

      <h3>{{ 'portal.admin.ops.apiKeys.revoke' | transloco }}</h3>
      <form class="inline" (submit)="askRevoke($event)" novalidate>
        <label class="field">
          <span>{{ 'portal.admin.ops.apiKeys.keyId' | transloco }}</span>
          <input name="revokeId" [value]="revokeId()" (input)="revokeId.set(value($event))" />
        </label>
        <button type="submit" class="pill danger" [disabled]="busy()">
          {{ 'portal.admin.ops.apiKeys.revokeAction' | transloco }}
        </button>
      </form>
      <ng-container *ngTemplateOutlet="feedbackTpl; context: { $implicit: feedback().revokeKey }" />

      <h3>{{ 'portal.admin.ops.apiKeys.limit' | transloco }}</h3>
      <form class="inline" (submit)="setKeyLimit($event)" novalidate>
        <label class="field">
          <span>{{ 'portal.admin.ops.apiKeys.keyId' | transloco }}</span>
          <input
            name="limitKeyId"
            [value]="limitKey().keyId"
            (input)="setLimitKey('keyId', $event)"
          />
        </label>
        <label class="field">
          <span>{{ 'portal.admin.ops.rateLimit.requests' | transloco }}</span>
          <input
            inputmode="numeric"
            name="limitKeyRequests"
            [value]="limitKey().requests"
            (input)="setLimitKey('requests', $event)"
          />
        </label>
        <label class="field">
          <span>{{ 'portal.admin.ops.rateLimit.windowSeconds' | transloco }}</span>
          <input
            inputmode="numeric"
            name="limitKeyWindow"
            [value]="limitKey().windowSeconds"
            (input)="setLimitKey('windowSeconds', $event)"
          />
        </label>
        <button type="submit" class="pill" [disabled]="busy()">
          {{ 'portal.admin.ops.save' | transloco }}
        </button>
      </form>
      <ng-container *ngTemplateOutlet="feedbackTpl; context: { $implicit: feedback().keyLimit }" />
    </section>

    <section class="glass card" aria-labelledby="ops-access">
      <h2 id="ops-access">{{ 'portal.admin.ops.access.title' | transloco }}</h2>
      <h3>{{ 'portal.admin.ops.rateLimit.title' | transloco }}</h3>
      <form class="inline" (submit)="saveRateLimit($event)" novalidate>
        <label class="field">
          <span>{{ 'portal.admin.ops.rateLimit.requests' | transloco }}</span>
          <input
            inputmode="numeric"
            name="requests"
            [value]="rateLimit().requests"
            (input)="setRate('requests', $event)"
          />
        </label>
        <label class="field">
          <span>{{ 'portal.admin.ops.rateLimit.windowSeconds' | transloco }}</span>
          <input
            inputmode="numeric"
            name="windowSeconds"
            [value]="rateLimit().windowSeconds"
            (input)="setRate('windowSeconds', $event)"
          />
        </label>
        <button type="submit" class="pill" [disabled]="busy()">
          {{ 'portal.admin.ops.save' | transloco }}
        </button>
      </form>
      <ng-container *ngTemplateOutlet="feedbackTpl; context: { $implicit: feedback().rateLimit }" />

      <h3>{{ 'portal.admin.ops.accessMode.title' | transloco }}</h3>
      <form class="inline" (submit)="saveAccessMode($event)" novalidate>
        <label class="field">
          <span>{{ 'portal.admin.ops.accessMode.label' | transloco }}</span>
          <select (change)="accessMode.set(modeOf($event))">
            @for (mode of modes; track mode) {
              <option [value]="mode" [selected]="mode === accessMode()">
                {{ 'portal.admin.ops.accessMode.' + mode | transloco }}
              </option>
            }
          </select>
        </label>
        <button type="submit" class="pill" [disabled]="busy()">
          {{ 'portal.admin.ops.save' | transloco }}
        </button>
      </form>
      <ng-container
        *ngTemplateOutlet="feedbackTpl; context: { $implicit: feedback().accessMode }"
      />
    </section>

    <section class="glass card" aria-labelledby="ops-duplicates">
      <h2 id="ops-duplicates">{{ 'portal.admin.ops.duplicates.title' | transloco }}</h2>
      <p class="note">{{ 'portal.admin.ops.duplicates.hint' | transloco }}</p>
      @if (duplicateDetection(); as state) {
        <div class="switch-row">
          <button
            type="button"
            role="switch"
            class="switch"
            [attr.aria-checked]="state.enabled"
            aria-labelledby="ops-duplicates"
            aria-describedby="ops-duplicates-status"
            [disabled]="busy()"
            (click)="toggleDuplicateDetection(state)"
          >
            <span class="knob" aria-hidden="true"></span>
          </button>
          <span id="ops-duplicates-status" class="badge" [class.suspended]="!state.enabled">{{
            state.statusKey | transloco
          }}</span>
          <button
            type="button"
            class="pill"
            [class.danger]="state.enabled"
            [class.primary]="!state.enabled"
            [disabled]="busy()"
            (click)="toggleDuplicateDetection(state)"
          >
            {{ state.actionKey | transloco }}
          </button>
        </div>
        @if (!state.enabled) {
          <p class="note">{{ 'portal.admin.ops.duplicates.offNote' | transloco }}</p>
        }
      } @else if (!feedback().duplicates?.error) {
        <p class="note" role="status">{{ 'portal.admin.loading' | transloco }}</p>
      }
      <ng-container
        *ngTemplateOutlet="feedbackTpl; context: { $implicit: feedback().duplicates }"
      />
    </section>

    <section class="glass card" aria-labelledby="ops-reload">
      <h2 id="ops-reload">{{ 'portal.admin.ops.reload.title' | transloco }}</h2>
      <p class="note">{{ 'portal.admin.ops.reload.hint' | transloco }}</p>
      <button type="button" class="pill" [disabled]="busy()" (click)="runReload()">
        {{ 'portal.admin.ops.reload.action' | transloco }}
      </button>
      <ng-container *ngTemplateOutlet="feedbackTpl; context: { $implicit: feedback().reload }" />
      @if (reloadOutcomes(); as outcomes) {
        <div class="scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">{{ 'portal.admin.ops.reload.function' | transloco }}</th>
                <th scope="col">{{ 'portal.admin.ops.reload.result' | transloco }}</th>
              </tr>
            </thead>
            <tbody>
              @for (outcome of outcomes; track outcome.functionName) {
                <tr>
                  <th scope="row">{{ outcome.functionName }}</th>
                  @if (outcome.status === 'updated') {
                    <td>
                      {{
                        'portal.admin.ops.reload.updated'
                          | transloco: { version: outcome.configVersion }
                      }}
                    </td>
                  } @else {
                    <td class="error">
                      {{ 'portal.admin.ops.reload.failed' | transloco: { error: outcome.error } }}
                    </td>
                  }
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
    </section>

    <section class="glass card" aria-labelledby="ops-admins">
      <h2 id="ops-admins">{{ 'portal.admin.ops.admins.title' | transloco }}</h2>
      <ng-container *ngTemplateOutlet="feedbackTpl; context: { $implicit: feedback().admins }" />
      <div class="scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">{{ 'portal.admin.ops.admins.name' | transloco }}</th>
              <th scope="col">{{ 'portal.admin.ops.admins.email' | transloco }}</th>
              <th scope="col">
                <span class="visually-hidden">{{
                  'portal.admin.ops.admins.actions' | transloco
                }}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            @for (admin of admins(); track admin.userId) {
              <tr>
                <th scope="row">{{ admin.displayName }}</th>
                <td>{{ admin.email }}</td>
                <td>
                  <button
                    type="button"
                    class="pill danger"
                    [disabled]="busy()"
                    (click)="askRemoveAdmin(admin)"
                  >
                    {{ 'portal.admin.ops.admins.remove' | transloco }}
                  </button>
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
      @if (adminsToken()) {
        <button type="button" class="pill" [disabled]="busy()" (click)="loadAdmins(true)">
          {{ 'portal.monitoring.loadMore' | transloco }}
        </button>
      }
      <form class="inline" (submit)="addAdmin($event)" novalidate>
        <label class="field">
          <span>{{ 'portal.admin.ops.admins.email' | transloco }}</span>
          <input type="email" name="email" [value]="email()" (input)="email.set(value($event))" />
        </label>
        <button type="submit" class="pill primary" [disabled]="busy()">
          {{ 'portal.admin.ops.admins.add' | transloco }}
        </button>
      </form>
    </section>

    <ng-template #feedbackTpl let-f>
      @if (f?.error) {
        <p class="error" role="alert">{{ f.error }}</p>
      } @else if (f?.done) {
        <p class="success" role="status">{{ f.done | transloco: f.params ?? {} }}</p>
      }
    </ng-template>

    <ng-template #requestTpl let-r>
      <dl class="facts">
        <div>
          <dt>{{ 'portal.admin.ops.lookup.requestId' | transloco }}</dt>
          <dd>
            <code>{{ r.requestId }}</code>
          </dd>
        </div>
        <div>
          <dt>{{ 'portal.admin.ops.lookup.status' | transloco }}</dt>
          <dd>{{ 'portal.admin.ops.lookup.state.' + r.status | transloco }}</dd>
        </div>
        @if (r.requestedAt) {
          <div>
            <dt>{{ 'portal.admin.ops.lookup.requestedAt' | transloco }}</dt>
            <dd>{{ timestamp(r.requestedAt) }}</dd>
          </div>
        }
        @if (r.executedAt) {
          <div>
            <dt>{{ 'portal.admin.ops.lookup.executedAt' | transloco }}</dt>
            <dd>{{ timestamp(r.executedAt) }}</dd>
          </div>
        }
        @if (r.removedCount !== undefined) {
          <div>
            <dt>{{ 'portal.admin.ops.lookup.removed' | transloco }}</dt>
            <dd>{{ r.removedCount }}</dd>
          </div>
        }
      </dl>
    </ng-template>

    <oe-admin-confirm-dialog
      [confirmation]="pending()?.confirmation"
      [busy]="busy()"
      (confirmed)="confirm()"
      (cancelled)="pending.set(undefined)"
    />
  `,
  styles: [
    ADMIN_STYLES,
    `
      .facts {
        display: grid;
        gap: 0.25rem;
        margin: 0;
      }
      .facts > div {
        display: flex;
        gap: 1rem;
      }
      dt {
        color: var(--color-text-muted);
      }
      dd {
        margin: 0;
      }
      .secret {
        padding: 0.75rem 1rem;
        border: 1px solid var(--color-accent);
        border-radius: 0.75rem;
      }
      .secret p {
        margin: 0 0 0.4rem;
      }
      .switch-row {
        display: flex;
        flex-wrap: wrap;
        gap: 0.75rem 1rem;
        align-items: center;
      }
      .switch {
        position: relative;
        width: 2.75rem;
        height: 1.5rem;
        padding: 0;
        border: 1px solid var(--color-surface-border);
        border-radius: var(--radius-pill);
        background: var(--color-surface);
        cursor: pointer;
      }
      .switch[aria-checked='true'] {
        border-color: transparent;
        background: var(--color-accent);
      }
      .switch:disabled {
        opacity: 0.5;
        cursor: default;
      }
      .knob {
        position: absolute;
        top: 0.15rem;
        left: 0.15rem;
        width: 1.1rem;
        height: 1.1rem;
        border-radius: 50%;
        background: var(--color-text-muted);
        transition: transform 0.15s ease;
      }
      .switch[aria-checked='true'] .knob {
        transform: translateX(1.25rem);
        background: var(--color-on-accent);
      }
      @media (prefers-reduced-motion: reduce) {
        .knob {
          transition: none;
        }
      }
    `,
  ],
})
export class AdminOperationsComponent {
  private readonly api = inject(ManagementApiClient);
  private readonly locale = inject(LocaleService);
  private readonly transloco = inject(TranslocoService);
  private readonly controller = new AbortController();
  private readonly signal = this.controller.signal;

  protected readonly modes = ACCESS_MODES;

  protected readonly busy = signal(false);
  protected readonly feedback = signal<Partial<Record<Section, Feedback>>>({});
  protected readonly pending = signal<Pending | undefined>(undefined);

  protected readonly deletionKind = signal<DeletionKind>('listingId');
  protected readonly deletionValue = signal('');
  protected readonly deletionResult = signal<DeletionRequestValue | undefined>(undefined);
  protected readonly requestId = signal('');
  protected readonly lookupResult = signal<DeletionRequestValue | undefined>(undefined);
  protected readonly blockedId = signal('');

  protected readonly keyForm = signal({ expiresAt: '', requests: '', windowSeconds: '' });
  protected readonly createdKey = signal<CreatedApiKeyValue | undefined>(undefined);
  protected readonly revokeId = signal('');
  protected readonly limitKey = signal({ keyId: '', requests: '', windowSeconds: '' });
  protected readonly rateLimit = signal({ requests: '', windowSeconds: '' });
  protected readonly accessMode = signal<AccessMode>('open');
  protected readonly reloadOutcomes = signal<ReloadOutcomeData[] | undefined>(undefined);
  protected readonly duplicateDetection = signal<DuplicateDetectionState | undefined>(undefined);

  protected readonly admins = signal<PlatformAdminRow[]>([]);
  protected readonly adminsToken = signal<string | undefined>(undefined);
  protected readonly email = signal('');

  constructor() {
    inject(DestroyRef).onDestroy(() => this.controller.abort());
    void this.loadAdmins(false);
    void this.loadDuplicateDetection();
  }

  protected value(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected kindOf(event: Event): DeletionKind {
    return (event.target as HTMLSelectElement).value === 'source' ? 'source' : 'listingId';
  }

  protected modeOf(event: Event): AccessMode {
    return (event.target as HTMLSelectElement).value === 'api-keys' ? 'api-keys' : 'open';
  }

  protected timestamp(iso: string): string {
    return formatTimestamp(iso, this.locale.active());
  }

  protected setKeyForm(field: 'expiresAt' | 'requests' | 'windowSeconds', event: Event): void {
    const value = this.value(event);
    this.keyForm.update((form) => ({ ...form, [field]: value }));
  }

  protected setLimitKey(field: 'keyId' | 'requests' | 'windowSeconds', event: Event): void {
    const value = this.value(event);
    this.limitKey.update((form) => ({ ...form, [field]: value }));
  }

  protected setRate(field: 'requests' | 'windowSeconds', event: Event): void {
    const value = this.value(event);
    this.rateLimit.update((form) => ({ ...form, [field]: value }));
  }

  // --- feedback helpers ----------------------------------------------------------------------

  private report(section: Section, feedback: Feedback): void {
    this.feedback.update((all) => ({ ...all, [section]: feedback }));
  }

  private invalid(section: Section, result: Extract<FieldResult<unknown>, { ok: false }>): void {
    this.report(section, {
      error: this.transloco.translate(result.messageKey, result.params ?? {}),
    });
  }

  /** Runs one call with the shared busy flag; failures keep the form values (Req 5.9). */
  private async run<T>(
    section: Section,
    call: () => Promise<ManagementResult<T>>,
    onSuccess: (value: T) => void,
    done?: string,
  ): Promise<boolean> {
    this.busy.set(true);
    this.report(section, {});
    const result = await call();
    this.busy.set(false);
    if (!result.ok) {
      this.fail(section, result.error);
      return false;
    }
    onSuccess(result.value);
    this.report(section, done === undefined ? {} : { done });
    return true;
  }

  private fail(section: Section, error: ManagementError): void {
    const message = this.api.errorMessage(error);
    if (message !== undefined) this.report(section, { error: message });
  }

  protected async confirm(): Promise<void> {
    const pending = this.pending();
    if (!pending) return;
    await pending.run();
    this.pending.set(undefined);
  }

  // --- deletion requests ---------------------------------------------------------------------

  /** Counts the affected listings (`dryRun`) before asking (Req 10.8). */
  protected async askDeletion(event: Event): Promise<void> {
    event.preventDefault();
    const criterion = deletionCriterion(this.deletionKind(), this.deletionValue());
    if (!criterion.ok) return this.invalid('deletion', criterion);
    await this.run(
      'deletion',
      () => previewDeletion(this.api, criterion.value, { signal: this.signal }),
      (preview) =>
        this.pending.set({
          confirmation: confirmation('deletion', this.deletionValue().trim(), preview),
          run: () =>
            this.run(
              'deletion',
              () => requestDeletion(this.api, criterion.value, { signal: this.signal }),
              (request) => {
                this.deletionResult.set(request);
                this.deletionValue.set('');
              },
              'portal.admin.ops.deletion.done',
            ).then(() => undefined),
        }),
    );
  }

  protected async lookup(event: Event): Promise<void> {
    event.preventDefault();
    const id = requiredId('requestId', this.requestId());
    if (!id.ok) return this.invalid('lookup', id);
    await this.run(
      'lookup',
      () => getDeletion(this.api, id.value, { signal: this.signal }),
      (request) => this.lookupResult.set(request),
    );
  }

  protected async unblock(event: Event): Promise<void> {
    event.preventDefault();
    const id = requiredId('listingId', this.blockedId());
    if (!id.ok) return this.invalid('blocklist', id);
    await this.run(
      'blocklist',
      () => removeBlocklistEntry(this.api, id.value, { signal: this.signal }),
      () => this.blockedId.set(''),
      'portal.admin.ops.blocklist.done',
    );
  }

  // --- API keys, rate limits, access mode ------------------------------------------------------

  protected async createKey(event: Event): Promise<void> {
    event.preventDefault();
    const body = apiKeyRequest(this.keyForm(), new Date());
    if (!body.ok) return this.invalid('apiKey', body);
    await this.run(
      'apiKey',
      () => createApiKey(this.api, body.value, { signal: this.signal }),
      (key) => {
        this.createdKey.set(key);
        this.keyForm.set({ expiresAt: '', requests: '', windowSeconds: '' });
      },
    );
  }

  /** The API has no `dryRun` for API keys; the dialog says so. */
  protected askRevoke(event: Event): void {
    event.preventDefault();
    const id = requiredId('keyId', this.revokeId());
    if (!id.ok) return this.invalid('revokeKey', id);
    this.report('revokeKey', {});
    this.pending.set({
      confirmation: confirmation('revokeApiKey', id.value, undefined),
      run: () =>
        this.run(
          'revokeKey',
          () => revokeApiKey(this.api, id.value, { signal: this.signal }),
          () => this.revokeId.set(''),
          'portal.admin.ops.apiKeys.revoked',
        ).then(() => undefined),
    });
  }

  protected async setKeyLimit(event: Event): Promise<void> {
    event.preventDefault();
    const form = this.limitKey();
    const id = requiredId('keyId', form.keyId);
    if (!id.ok) return this.invalid('keyLimit', id);
    const limit = parseRateLimit(form.requests, form.windowSeconds);
    if (!limit.ok) return this.invalid('keyLimit', limit);
    await this.run(
      'keyLimit',
      () => setApiKeyRateLimit(this.api, id.value, limit.value, { signal: this.signal }),
      () => undefined,
      'portal.admin.ops.saved',
    );
  }

  protected async saveRateLimit(event: Event): Promise<void> {
    event.preventDefault();
    const form = this.rateLimit();
    const limit = parseRateLimit(form.requests, form.windowSeconds);
    if (!limit.ok) return this.invalid('rateLimit', limit);
    await this.run(
      'rateLimit',
      () => setRateLimit(this.api, limit.value, { signal: this.signal }),
      () => undefined,
      'portal.admin.ops.saved',
    );
  }

  protected async saveAccessMode(event: Event): Promise<void> {
    event.preventDefault();
    await this.run(
      'accessMode',
      () => setAccessMode(this.api, this.accessMode(), { signal: this.signal }),
      () => undefined,
      'portal.admin.ops.saved',
    );
  }

  protected async runReload(): Promise<void> {
    await this.run(
      'reload',
      () => reload(this.api, { signal: this.signal }),
      (outcomes) => this.reloadOutcomes.set(outcomes),
    );
    const outcomes = this.reloadOutcomes();
    if (outcomes && reloadFailed(outcomes) > 0) {
      this.report('reload', {
        error: this.transloco.translate('portal.admin.ops.reload.someFailed', {
          count: reloadFailed(outcomes),
        }),
      });
    }
  }

  // --- Ein/Aus of the Duplikat-Erkennung -----------------------------------------------------

  private async loadDuplicateDetection(): Promise<void> {
    await this.run(
      'duplicates',
      () => getDuplicateDetection(this.api, { signal: this.signal }),
      (view) => this.duplicateDetection.set(toDuplicateDetectionState(view)),
    );
  }

  /**
   * Switching off asks first (no check, no flags until switched on again); switching on starts
   * the duplicate check that rebuilds the index.
   */
  protected toggleDuplicateDetection(state: DuplicateDetectionState): void {
    const change = () => this.switchDuplicateDetection(!state.enabled);
    if (!state.enabled) {
      void change();
      return;
    }
    this.report('duplicates', {});
    this.pending.set({ confirmation: disableDuplicateDetectionConfirmation(), run: change });
  }

  private async switchDuplicateDetection(enabled: boolean): Promise<void> {
    const switched: { message?: TranslatedText } = {};
    await this.run(
      'duplicates',
      () => setDuplicateDetection(this.api, enabled, { signal: this.signal }),
      (view) => {
        this.duplicateDetection.set(toDuplicateDetectionState(view));
        switched.message = duplicateDetectionSwitched(view);
      },
    );
    const { message } = switched;
    if (message === undefined) return;
    this.report('duplicates', {
      done: message.key,
      ...(message.params !== undefined && { params: message.params }),
    });
  }

  // --- Plattform_Admins ----------------------------------------------------------------------

  protected async loadAdmins(more: boolean): Promise<void> {
    const token = more ? this.adminsToken() : undefined;
    await this.run(
      'admins',
      () =>
        listPlatformAdmins(this.api, {
          ...(token !== undefined && { pageToken: token }),
          signal: this.signal,
        }),
      (page) => {
        const rows = page.items.map(({ userId, email, displayName }) => ({
          userId,
          email,
          displayName,
        }));
        this.admins.update((current) => (more ? [...current, ...rows] : rows));
        this.adminsToken.set(page.nextPageToken);
      },
    );
  }

  protected async addAdmin(event: Event): Promise<void> {
    event.preventDefault();
    const email = validateEmail(this.email());
    if (!email.ok) return this.invalid('admins', email);
    const added = await this.run(
      'admins',
      () => addPlatformAdmin(this.api, email.value, { signal: this.signal }),
      () => this.email.set(''),
    );
    if (added) {
      await this.loadAdmins(false);
      this.report('admins', { done: 'portal.admin.ops.admins.added' });
    }
  }

  /** Counts the affected users (`dryRun`) before asking (Req 10.8). */
  protected async askRemoveAdmin(admin: PlatformAdminRow): Promise<void> {
    await this.run(
      'admins',
      () => previewRemovePlatformAdmin(this.api, admin.userId, { signal: this.signal }),
      (preview) =>
        this.pending.set({
          confirmation: confirmation(
            'removePlatformAdmin',
            admin.displayName || admin.email,
            preview,
          ),
          run: async () => {
            const removed = await this.run(
              'admins',
              () => removePlatformAdmin(this.api, admin.userId, { signal: this.signal }),
              () => undefined,
            );
            if (removed) {
              await this.loadAdmins(false);
              this.report('admins', { done: 'portal.admin.ops.admins.removed' });
            }
          },
        }),
    );
  }
}
