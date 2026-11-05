import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  signal,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { PortalSession } from '../../auth/portal-session.service';
import { LocaleService } from '../../locale/locale.service';
import { ManagementApiClient } from '../../management/management-api-client.service';
import { formatTimestamp } from '../listings/listing-table-model';
import {
  ConfirmDialogComponent,
  type ConfirmDialogState,
} from '../shared/confirm-dialog/confirm-dialog.component';
import { errorFields } from '../shared/management-caller';
import {
  accessState,
  createErrorsFromApi,
  createMachineAccess,
  EMPTY_CREATE,
  fetchMachineAccesses,
  GRANTABLE_PERMISSIONS,
  permissionKey,
  previewRevocation,
  revocationImpact,
  revokeMachineAccess,
  splitSecret,
  upsertAccess,
  validateCreate,
  type CreateError,
  type CreateField,
  type MachineAccess,
} from './machine-access-model';

interface Revocation {
  readonly access: MachineAccess;
  readonly dialog: ConfirmDialogState;
  readonly busy: boolean;
  readonly errorMessage?: string;
}

/** Secret of the access just created; only in memory, gone once dismissed (Req 3.1, 3.2). */
interface IssuedSecret {
  readonly label: string;
  readonly secret: string;
  readonly copied: 'idle' | 'done' | 'failed';
}

/**
 * `/portal/machine-access` (Req 3.1, 3.5, 3.7): create machine accesses with label, grantable
 * permissions and optional expiry, show the secret exactly once with a copy button, list all
 * accesses without secret and revoke them after a `dryRun` confirmation.
 */
@Component({
  selector: 'oe-machine-access',
  imports: [TranslocoPipe, ConfirmDialogComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="glass panel" aria-labelledby="ma-title">
      <h1 id="ma-title" class="label">{{ 'portal.machineAccess.title' | transloco }}</h1>

      @if (agencyId() === undefined) {
        <p class="muted" role="status">{{ 'portal.machineAccess.noAgency' | transloco }}</p>
      } @else {
        @if (issued(); as s) {
          <div class="secret" role="region" aria-labelledby="secret-title">
            <h2 id="secret-title" class="label">
              {{ 'portal.machineAccess.secret.title' | transloco: { label: s.label } }}
            </h2>
            <p>{{ 'portal.machineAccess.secret.once' | transloco }}</p>
            <div class="secret-row">
              <label class="visually-hidden" for="secret-value">{{
                'portal.machineAccess.secret.label' | transloco
              }}</label>
              <input
                id="secret-value"
                type="text"
                readonly
                spellcheck="false"
                autocomplete="off"
                [value]="s.secret"
                (focus)="$any($event.target).select()"
              />
              <button type="button" class="pill primary" (click)="copySecret()">
                {{ 'portal.machineAccess.secret.copy' | transloco }}
              </button>
            </div>
            <p role="status" [class.error]="s.copied === 'failed'">
              @if (s.copied === 'done') {
                {{ 'portal.machineAccess.secret.copied' | transloco }}
              } @else if (s.copied === 'failed') {
                {{ 'portal.machineAccess.secret.copyFailed' | transloco }}
              }
            </p>
            <button type="button" class="pill" (click)="dismissSecret()">
              {{ 'portal.machineAccess.secret.dismiss' | transloco }}
            </button>
          </div>
        }

        <form
          class="create"
          (submit)="$event.preventDefault(); submit()"
          novalidate
          aria-labelledby="create-title"
        >
          <h2 id="create-title" class="label">
            {{ 'portal.machineAccess.create.title' | transloco }}
          </h2>
          <div class="row">
            <div class="field wide">
              <label for="ma-label">{{ 'portal.machineAccess.field.label' | transloco }}</label>
              <input
                id="ma-label"
                autocomplete="off"
                [value]="values().label"
                (input)="setLabel($any($event.target).value)"
                [attr.aria-invalid]="invalid('label')"
                [attr.aria-describedby]="describedBy('label')"
              />
            </div>
            <div class="field">
              <label for="ma-expires">{{
                'portal.machineAccess.field.expiresAt' | transloco
              }}</label>
              <input
                id="ma-expires"
                type="datetime-local"
                [value]="values().expiresAt"
                (input)="setExpiry($any($event.target).value)"
                [attr.aria-invalid]="invalid('expiresAt')"
                [attr.aria-describedby]="describedBy('expiresAt')"
              />
            </div>
          </div>
          <fieldset
            [attr.aria-invalid]="invalid('permissions')"
            [attr.aria-describedby]="describedBy('permissions')"
          >
            <legend>{{ 'portal.machineAccess.field.permissions' | transloco }}</legend>
            @for (permission of permissions; track permission) {
              <label class="check">
                <input
                  type="checkbox"
                  [checked]="values().permissions.includes(permission)"
                  (change)="togglePermission(permission, $any($event.target).checked)"
                />
                <span>{{ permissionKey(permission) | transloco }}</span>
                <code>{{ permission }}</code>
              </label>
            }
          </fieldset>
          <p class="muted">{{ 'portal.machineAccess.create.hint' | transloco }}</p>
          @if (createErrors().length > 0) {
            <ul class="errors" role="alert">
              @for (error of createErrors(); track error.field) {
                <li [id]="'ma-error-' + error.field">
                  {{ error.messageKey | transloco: error.params ?? {} }}
                </li>
              }
            </ul>
          }
          @if (createFailure(); as message) {
            <p class="error" role="alert">{{ message }}</p>
          }
          <div>
            <button type="submit" class="pill primary" [disabled]="creating()">
              {{
                (creating()
                  ? 'portal.machineAccess.create.creating'
                  : 'portal.machineAccess.create.submit'
                ) | transloco
              }}
            </button>
          </div>
        </form>

        @if (notice(); as n) {
          <p class="success" role="status">{{ n | transloco }}</p>
        }

        @if (errorText(); as message) {
          <div class="notice error" role="alert">
            <p>{{ message }}</p>
            <button type="button" class="pill" (click)="reload()">
              {{ 'portal.machineAccess.retry' | transloco }}
            </button>
          </div>
        }

        <div class="table-wrap" [attr.aria-busy]="loading()">
          <table>
            <caption class="visually-hidden">
              {{
                'portal.machineAccess.caption' | transloco
              }}
            </caption>
            <thead>
              <tr>
                <th scope="col">{{ 'portal.machineAccess.field.label' | transloco }}</th>
                <th scope="col">{{ 'portal.machineAccess.column.state' | transloco }}</th>
                <th scope="col">{{ 'portal.machineAccess.field.permissions' | transloco }}</th>
                <th scope="col">{{ 'portal.machineAccess.column.created' | transloco }}</th>
                <th scope="col">{{ 'portal.machineAccess.field.expiresAt' | transloco }}</th>
                <th scope="col">{{ 'portal.machineAccess.column.revokedAt' | transloco }}</th>
                <th scope="col">{{ 'portal.machineAccess.column.lastUsedAt' | transloco }}</th>
                <th scope="col">
                  <span class="visually-hidden">{{
                    'portal.machineAccess.column.actions' | transloco
                  }}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              @for (access of accesses(); track access.keyId) {
                @let state = stateOf(access);
                <tr [class.inactive]="state !== 'active'">
                  <th scope="row">
                    {{ access.label }}
                    <code class="id">{{ access.keyId }}</code>
                  </th>
                  <td>
                    <span class="badge" [class.active]="state === 'active'">
                      {{ 'portal.machineAccess.state.' + state | transloco }}
                    </span>
                  </td>
                  <td>
                    <ul class="plain">
                      @for (permission of access.permissions; track permission) {
                        <li>{{ permissionKey(permission) | transloco }}</li>
                      }
                    </ul>
                  </td>
                  <td>
                    <time [attr.datetime]="access.createdAt">{{
                      timestamp(access.createdAt)
                    }}</time>
                    <span class="muted">
                      {{ 'portal.machineAccess.createdBy' | transloco: { user: access.createdBy } }}
                    </span>
                  </td>
                  <td>
                    @if (access.expiresAt; as at) {
                      <time [attr.datetime]="at">{{ timestamp(at) }}</time>
                    } @else {
                      {{ 'portal.machineAccess.none' | transloco }}
                    }
                  </td>
                  <td>
                    @if (access.revokedAt; as at) {
                      <time [attr.datetime]="at">{{ timestamp(at) }}</time>
                    } @else {
                      {{ 'portal.machineAccess.none' | transloco }}
                    }
                  </td>
                  <td>
                    @if (access.lastUsedAt; as at) {
                      <time [attr.datetime]="at">{{ timestamp(at) }}</time>
                    } @else {
                      {{ 'portal.machineAccess.neverUsed' | transloco }}
                    }
                  </td>
                  <td>
                    @if (access.revokedAt === undefined) {
                      <button
                        type="button"
                        class="pill"
                        [attr.aria-label]="
                          'portal.machineAccess.revokeNamed' | transloco: { label: access.label }
                        "
                        (click)="startRevocation(access)"
                      >
                        {{ 'portal.machineAccess.revokeAction' | transloco }}
                      </button>
                    }
                  </td>
                </tr>
              } @empty {
                @if (!loading() && errorText() === undefined) {
                  <tr>
                    <td colspan="8" class="muted">
                      {{ 'portal.machineAccess.empty' | transloco }}
                    </td>
                  </tr>
                }
              }
            </tbody>
          </table>
          @if (loading()) {
            <p class="muted" role="status">{{ 'portal.machineAccess.loading' | transloco }}</p>
          }
        </div>
        @if (nextToken() !== undefined) {
          <button type="button" class="pill more" [disabled]="loading()" (click)="loadMore()">
            {{ 'portal.machineAccess.loadMore' | transloco }}
          </button>
        }
      }
    </section>

    @if (revocation(); as r) {
      <oe-confirm-dialog
        titleKey="portal.machineAccess.revoke.title"
        introKey="portal.machineAccess.revoke.intro"
        confirmKey="portal.machineAccess.revoke.confirm"
        cancelKey="portal.machineAccess.revoke.cancel"
        loadingKey="portal.machineAccess.revoke.loading"
        [params]="{ label: r.access.label }"
        [state]="r.dialog"
        [busy]="r.busy"
        [errorMessage]="r.errorMessage"
        (confirm)="confirmRevocation()"
        (cancel)="revocation.set(undefined)"
      />
    }
  `,
  styles: `
    .panel {
      display: grid;
      gap: 1.25rem;
      padding: 1.25rem 1.5rem;
    }
    h1,
    h2,
    p {
      margin: 0;
    }
    .create,
    .secret {
      display: grid;
      gap: 0.6rem;
    }
    .secret {
      padding: 1rem 1.25rem;
      border: 1px solid var(--brand-secondary);
      border-radius: var(--radius-card);
    }
    .secret-row,
    .row {
      display: flex;
      flex-wrap: wrap;
      align-items: flex-end;
      gap: 0.75rem 1rem;
    }
    .secret-row input {
      flex: 1 1 20rem;
      font-family: monospace;
    }
    .field {
      display: grid;
      gap: 0.25rem;
      flex: 1 1 12rem;
      font-size: 0.875rem;
    }
    .field.wide {
      flex-basis: 18rem;
    }
    label,
    legend,
    .muted {
      color: var(--color-text-muted);
    }
    input:not([type='checkbox']) {
      padding: 0.45rem 0.75rem;
      border: 1px solid var(--color-surface-border);
      border-radius: 0.75rem;
      background: var(--color-surface);
      color: inherit;
      font: inherit;
    }
    fieldset {
      display: grid;
      gap: 0.35rem;
      margin: 0;
      padding: 0.75rem 1rem;
      border: 1px solid var(--color-surface-border);
      border-radius: 0.75rem;
    }
    .check {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      color: inherit;
    }
    code {
      color: var(--color-text-muted);
      font-size: 0.8rem;
    }
    .id {
      display: block;
    }
    [aria-invalid='true'] {
      border-color: var(--color-error);
    }
    .errors {
      margin: 0;
      padding-left: 1.25rem;
    }
    .errors,
    .error {
      color: var(--color-error);
    }
    .success {
      color: var(--brand-secondary);
    }
    .notice {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 1rem;
    }
    .pill {
      display: inline-block;
      padding: 0.4rem 1.1rem;
      border: 1px solid var(--color-surface-border);
      border-radius: var(--radius-pill);
      background: transparent;
      color: inherit;
      font: inherit;
      cursor: pointer;
    }
    .pill.primary {
      border-color: transparent;
      background: var(--brand-secondary);
      color: var(--color-on-accent);
    }
    .pill:disabled {
      opacity: 0.5;
      cursor: default;
    }
    .more {
      justify-self: center;
    }
    .table-wrap {
      overflow-x: auto;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.875rem;
    }
    th,
    td {
      padding: 0.6rem 0.75rem;
      border-bottom: 1px solid var(--color-surface-border);
      text-align: left;
      vertical-align: top;
    }
    thead th {
      color: var(--color-text-muted);
      font-weight: 600;
    }
    tbody th {
      font-weight: 500;
    }
    tr.inactive {
      color: var(--color-text-muted);
    }
    .plain {
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .badge {
      padding: 0.15rem 0.6rem;
      border: 1px solid var(--color-surface-border);
      border-radius: var(--radius-pill);
      white-space: nowrap;
    }
    .badge.active {
      border-color: transparent;
      background: var(--brand-secondary);
      color: var(--color-on-accent);
    }
    .visually-hidden {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
      white-space: nowrap;
    }
  `,
})
export class MachineAccessComponent {
  private readonly api = inject(ManagementApiClient);
  private readonly locale = inject(LocaleService);
  private readonly session = inject(PortalSession);

  protected readonly permissions = GRANTABLE_PERMISSIONS;
  protected readonly permissionKey = permissionKey;
  protected readonly agencyId = computed(() => this.session.me()?.agencyId);

  protected readonly values = signal({ ...EMPTY_CREATE });
  protected readonly createErrors = signal<readonly CreateError[]>([]);
  protected readonly createFailure = signal<string | undefined>(undefined);
  protected readonly creating = signal(false);
  private readonly createErrorFields = computed(
    () => new Set(this.createErrors().map((e) => e.field)),
  );
  protected readonly issued = signal<IssuedSecret | undefined>(undefined);

  protected readonly accesses = signal<readonly MachineAccess[]>([]);
  protected readonly nextToken = signal<string | undefined>(undefined);
  protected readonly loading = signal(false);
  protected readonly errorText = signal<string | undefined>(undefined);
  protected readonly notice = signal<string | undefined>(undefined);
  protected readonly revocation = signal<Revocation | undefined>(undefined);

  private controller: AbortController | undefined;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.controller?.abort();
      this.issued.set(undefined);
    });
    void this.load();
  }

  protected reload(): void {
    void this.load();
  }

  protected loadMore(): void {
    const token = this.nextToken();
    if (token !== undefined) void this.load(token);
  }

  protected stateOf(access: MachineAccess) {
    return accessState(access, new Date());
  }

  protected timestamp(iso: string): string {
    return formatTimestamp(iso, this.locale.active());
  }

  protected invalid(field: CreateField): 'true' | null {
    return this.createErrorFields().has(field) ? 'true' : null;
  }

  protected describedBy(field: CreateField): string | null {
    return this.createErrorFields().has(field) ? `ma-error-${field}` : null;
  }

  protected setLabel(label: string): void {
    this.values.update((v) => ({ ...v, label }));
  }

  protected setExpiry(expiresAt: string): void {
    this.values.update((v) => ({ ...v, expiresAt }));
  }

  protected togglePermission(permission: string, checked: boolean): void {
    this.values.update((v) => ({
      ...v,
      permissions: checked
        ? [...v.permissions.filter((p) => p !== permission), permission]
        : v.permissions.filter((p) => p !== permission),
    }));
  }

  protected async submit(): Promise<void> {
    const agencyId = this.agencyId();
    if (agencyId === undefined || this.creating()) return;
    this.createFailure.set(undefined);
    this.notice.set(undefined);
    const validated = validateCreate(this.values(), new Date());
    if (!validated.ok) {
      this.createErrors.set(validated.errors);
      return;
    }
    this.createErrors.set([]);
    this.creating.set(true);
    const result = await createMachineAccess(this.api, agencyId, validated.request);
    this.creating.set(false);
    if (!result.ok) {
      // The entries stay in the form (Req 5.9); 400 INVALID_PERMISSION names each permission.
      this.createErrors.set(createErrorsFromApi(errorFields(result.error)));
      this.createFailure.set(this.api.errorMessage(result.error));
      return;
    }
    const { access, secret } = splitSecret(result.value);
    this.accesses.update((accesses) => upsertAccess(accesses, access));
    this.issued.set({ label: access.label, secret, copied: 'idle' });
    this.values.set({ ...EMPTY_CREATE });
  }

  protected async copySecret(): Promise<void> {
    const issued = this.issued();
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued.secret);
      this.issued.update((s) => s && { ...s, copied: 'done' });
    } catch {
      this.issued.update((s) => s && { ...s, copied: 'failed' });
    }
  }

  protected dismissSecret(): void {
    this.issued.set(undefined);
  }

  protected async startRevocation(access: MachineAccess): Promise<void> {
    const agencyId = this.agencyId();
    if (agencyId === undefined) return;
    this.notice.set(undefined);
    this.revocation.set({ access, dialog: { kind: 'loading' }, busy: false });
    const result = await previewRevocation(this.api, agencyId, access.keyId);
    if (this.revocation()?.access !== access) return;
    this.revocation.set({
      access,
      busy: false,
      dialog: result.ok
        ? { kind: 'ready', impact: revocationImpact(result.value) }
        : { kind: 'failed', message: this.api.errorMessage(result.error) ?? '' },
    });
  }

  protected async confirmRevocation(): Promise<void> {
    const agencyId = this.agencyId();
    const r = this.revocation();
    if (agencyId === undefined || !r || r.busy) return;
    this.revocation.set({ access: r.access, dialog: r.dialog, busy: true });
    const result = await revokeMachineAccess(this.api, agencyId, r.access.keyId);
    if (!result.ok) {
      const errorMessage = this.api.errorMessage(result.error);
      this.revocation.set({
        access: r.access,
        dialog: r.dialog,
        busy: false,
        ...(errorMessage !== undefined && { errorMessage }),
      });
      return;
    }
    this.revocation.set(undefined);
    this.accesses.update((accesses) => upsertAccess(accesses, result.value));
    this.notice.set('portal.machineAccess.revoked');
  }

  private async load(pageToken?: string): Promise<void> {
    const agencyId = this.agencyId();
    if (agencyId === undefined) return;
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    this.loading.set(true);
    this.errorText.set(undefined);
    const result = await fetchMachineAccesses(this.api, agencyId, {
      ...(pageToken !== undefined && { pageToken }),
      signal: controller.signal,
    });
    if (controller.signal.aborted) return;
    this.loading.set(false);
    if (!result.ok) {
      this.errorText.set(this.api.errorMessage(result.error));
      return;
    }
    const items = result.value.items;
    this.accesses.update((accesses) => (pageToken === undefined ? items : [...accesses, ...items]));
    this.nextToken.set(result.value.nextPageToken);
  }
}
