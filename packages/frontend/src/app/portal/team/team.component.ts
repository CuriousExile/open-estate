import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  signal,
} from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
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
  addMember,
  changeRole,
  EMPTY_INVITE,
  fetchMembers,
  inviteErrorsFromApi,
  isMemberRole,
  MEMBER_ROLES,
  previewRemoval,
  removalImpact,
  removeMember,
  roleKey,
  upsertMember,
  validateInvite,
  type InviteError,
  type InviteField,
  type Member,
} from './team-model';

interface Removal {
  readonly member: Member;
  readonly dialog: ConfirmDialogState;
  readonly busy: boolean;
  readonly errorMessage?: string;
}

interface Notice {
  readonly key: string;
  readonly params: Readonly<Record<string, string>>;
}

/**
 * `/portal/team` (Req 1.5–1.7): members of the agency with role, invitation by email and role,
 * role changes and removal. A removal is confirmed after a `dryRun` preview; the API answers 409
 * `LAST_AGENCY_ADMIN` if the agency would lose its last admin, and the state stays unchanged.
 */
@Component({
  selector: 'oe-team',
  imports: [ReactiveFormsModule, RouterLink, TranslocoPipe, ConfirmDialogComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="glass panel" aria-labelledby="team-title">
      <h1 id="team-title" class="label">{{ 'portal.team.title' | transloco }}</h1>

      @if (agencyId() === undefined) {
        <div class="notice" role="status">
          <p>{{ 'portal.team.noAgency' | transloco }}</p>
          @if (session.platformAdmin()) {
            <a class="pill" routerLink="/portal/admin">{{ 'portal.team.toAdmin' | transloco }}</a>
          }
        </div>
      } @else {
        <form
          class="invite"
          [formGroup]="invite"
          (ngSubmit)="submitInvite()"
          novalidate
          aria-labelledby="invite-title"
        >
          <h2 id="invite-title" class="label">{{ 'portal.team.invite.title' | transloco }}</h2>
          <p class="muted">{{ 'portal.team.invite.hint' | transloco }}</p>
          <div class="row">
            <div class="field wide">
              <label for="invite-email">{{ 'portal.team.invite.email' | transloco }}</label>
              <input
                id="invite-email"
                type="email"
                autocomplete="off"
                formControlName="email"
                [attr.aria-invalid]="invalid('email')"
                [attr.aria-describedby]="describedBy('email')"
              />
            </div>
            <div class="field">
              <label for="invite-role">{{ 'portal.team.column.role' | transloco }}</label>
              <select
                id="invite-role"
                formControlName="role"
                [attr.aria-invalid]="invalid('role')"
                [attr.aria-describedby]="describedBy('role')"
              >
                @for (role of roles; track role) {
                  <option [value]="role">{{ roleKey(role) | transloco }}</option>
                }
              </select>
            </div>
            <button type="submit" class="pill primary" [disabled]="inviting()">
              {{
                (inviting() ? 'portal.team.invite.sending' : 'portal.team.invite.submit')
                  | transloco
              }}
            </button>
          </div>
          @if (inviteErrors().length > 0) {
            <ul class="errors" role="alert">
              @for (error of inviteErrors(); track error.field) {
                <li [id]="'invite-error-' + error.field">{{ error.messageKey | transloco }}</li>
              }
            </ul>
          }
          @if (inviteFailure(); as message) {
            <p class="error" role="alert">{{ message }}</p>
          }
        </form>

        @if (notice(); as n) {
          <p class="success" role="status">{{ n.key | transloco: n.params }}</p>
        }

        @if (errorText(); as message) {
          <div class="notice error" role="alert">
            <p>{{ message }}</p>
            <button type="button" class="pill" (click)="reload()">
              {{ 'portal.team.retry' | transloco }}
            </button>
          </div>
        }

        <div class="table-wrap" [attr.aria-busy]="loading()">
          <table>
            <caption class="visually-hidden">
              {{
                'portal.team.caption' | transloco
              }}
            </caption>
            <thead>
              <tr>
                <th scope="col">{{ 'portal.team.column.name' | transloco }}</th>
                <th scope="col">{{ 'portal.team.column.email' | transloco }}</th>
                <th scope="col">{{ 'portal.team.column.role' | transloco }}</th>
                <th scope="col">{{ 'portal.team.column.createdAt' | transloco }}</th>
                <th scope="col">
                  <span class="visually-hidden">{{
                    'portal.team.column.actions' | transloco
                  }}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              @for (member of members(); track member.userId) {
                <tr>
                  <th scope="row">{{ member.displayName }}</th>
                  <td>{{ member.email }}</td>
                  <td>
                    <div class="role">
                      <label class="visually-hidden" [for]="'role-' + member.userId">
                        {{ 'portal.team.roleOf' | transloco: { name: member.displayName } }}
                      </label>
                      <select
                        [id]="'role-' + member.userId"
                        [value]="draftRole(member)"
                        [disabled]="savingRole() === member.userId"
                        (change)="setDraft(member, $any($event.target).value)"
                      >
                        @for (role of roles; track role) {
                          <option [value]="role" [selected]="role === draftRole(member)">
                            {{ roleKey(role) | transloco }}
                          </option>
                        }
                      </select>
                      @if (draftRole(member) !== member.role) {
                        <button
                          type="button"
                          class="pill primary"
                          [disabled]="savingRole() === member.userId"
                          (click)="saveRole(member)"
                        >
                          {{ 'portal.team.saveRole' | transloco }}
                        </button>
                      }
                    </div>
                    @if (rowError(); as e) {
                      @if (e.userId === member.userId) {
                        <p class="error" role="alert">{{ e.message }}</p>
                      }
                    }
                  </td>
                  <td>
                    <time [attr.datetime]="member.createdAt">{{
                      timestamp(member.createdAt)
                    }}</time>
                  </td>
                  <td>
                    <button
                      type="button"
                      class="pill"
                      [attr.aria-label]="
                        'portal.team.removeNamed' | transloco: { name: member.displayName }
                      "
                      (click)="startRemoval(member)"
                    >
                      {{ 'portal.team.removeAction' | transloco }}
                    </button>
                  </td>
                </tr>
              } @empty {
                @if (!loading() && errorText() === undefined) {
                  <tr>
                    <td colspan="5" class="muted">{{ 'portal.team.empty' | transloco }}</td>
                  </tr>
                }
              }
            </tbody>
          </table>
          @if (loading()) {
            <p class="muted" role="status">{{ 'portal.team.loading' | transloco }}</p>
          }
        </div>
        @if (nextToken() !== undefined) {
          <button type="button" class="pill more" [disabled]="loading()" (click)="loadMore()">
            {{ 'portal.team.loadMore' | transloco }}
          </button>
        }
      }
    </section>

    @if (removal(); as r) {
      <oe-confirm-dialog
        titleKey="portal.team.remove.title"
        introKey="portal.team.remove.intro"
        confirmKey="portal.team.remove.confirm"
        cancelKey="portal.team.remove.cancel"
        loadingKey="portal.team.remove.loading"
        [params]="{ name: r.member.displayName, email: r.member.email }"
        [state]="r.dialog"
        [busy]="r.busy"
        [errorMessage]="r.errorMessage"
        (confirm)="confirmRemoval()"
        (cancel)="removal.set(undefined)"
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
    .invite {
      display: grid;
      gap: 0.6rem;
    }
    .row,
    .role {
      display: flex;
      flex-wrap: wrap;
      align-items: flex-end;
      gap: 0.75rem 1rem;
    }
    .role {
      align-items: center;
      gap: 0.5rem;
    }
    .field {
      display: grid;
      gap: 0.25rem;
      flex: 1 1 10rem;
      font-size: 0.875rem;
    }
    .field.wide {
      flex-basis: 18rem;
    }
    label,
    .muted {
      color: var(--color-text-muted);
    }
    input,
    select {
      padding: 0.45rem 0.75rem;
      border: 1px solid var(--color-surface-border);
      border-radius: 0.75rem;
      background: var(--color-surface);
      color: inherit;
      font: inherit;
    }
    option {
      color: var(--color-on-accent);
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
      text-decoration: none;
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
export class TeamComponent {
  private readonly api = inject(ManagementApiClient);
  private readonly locale = inject(LocaleService);
  protected readonly session = inject(PortalSession);

  protected readonly roles = MEMBER_ROLES;
  protected readonly roleKey = roleKey;
  protected readonly agencyId = computed(() => this.session.me()?.agencyId);

  protected readonly invite = inject(NonNullableFormBuilder).group({ ...EMPTY_INVITE });
  protected readonly inviteErrors = signal<readonly InviteError[]>([]);
  protected readonly inviteFailure = signal<string | undefined>(undefined);
  protected readonly inviting = signal(false);
  private readonly inviteErrorFields = computed(
    () => new Set(this.inviteErrors().map((e) => e.field)),
  );

  protected readonly members = signal<readonly Member[]>([]);
  protected readonly nextToken = signal<string | undefined>(undefined);
  protected readonly loading = signal(false);
  protected readonly errorText = signal<string | undefined>(undefined);
  protected readonly notice = signal<Notice | undefined>(undefined);

  /** Selected but not yet saved roles by user id. */
  private readonly drafts = signal<Readonly<Record<string, string>>>({});
  protected readonly savingRole = signal<string | undefined>(undefined);
  protected readonly rowError = signal<{ userId: string; message: string } | undefined>(undefined);
  protected readonly removal = signal<Removal | undefined>(undefined);

  private controller: AbortController | undefined;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.controller?.abort());
    void this.load();
  }

  protected reload(): void {
    void this.load();
  }

  protected loadMore(): void {
    const token = this.nextToken();
    if (token !== undefined) void this.load(token);
  }

  protected timestamp(iso: string): string {
    return formatTimestamp(iso, this.locale.active());
  }

  protected invalid(field: InviteField): 'true' | null {
    return this.inviteErrorFields().has(field) ? 'true' : null;
  }

  protected describedBy(field: InviteField): string | null {
    return this.inviteErrorFields().has(field) ? `invite-error-${field}` : null;
  }

  protected draftRole(member: Member): string {
    return this.drafts()[member.userId] ?? member.role;
  }

  protected setDraft(member: Member, role: string): void {
    this.drafts.update((drafts) => ({ ...drafts, [member.userId]: role }));
    this.rowError.set(undefined);
  }

  protected async submitInvite(): Promise<void> {
    const agencyId = this.agencyId();
    if (agencyId === undefined || this.inviting()) return;
    this.inviteFailure.set(undefined);
    this.notice.set(undefined);
    const validated = validateInvite(this.invite.getRawValue());
    if (!validated.ok) {
      this.inviteErrors.set(validated.errors);
      return;
    }
    this.inviteErrors.set([]);
    this.inviting.set(true);
    const result = await addMember(this.api, agencyId, validated.request);
    this.inviting.set(false);
    if (!result.ok) {
      // The entries stay in the form (Req 5.9).
      this.inviteErrors.set(inviteErrorsFromApi(errorFields(result.error)));
      this.inviteFailure.set(this.api.errorMessage(result.error));
      return;
    }
    this.members.update((members) => upsertMember(members, result.value));
    this.invite.reset({ ...EMPTY_INVITE });
    this.notice.set({ key: 'portal.team.invite.done', params: { email: result.value.email } });
  }

  protected async saveRole(member: Member): Promise<void> {
    const agencyId = this.agencyId();
    const role = this.draftRole(member);
    if (agencyId === undefined || !isMemberRole(role) || this.savingRole() !== undefined) return;
    this.savingRole.set(member.userId);
    this.rowError.set(undefined);
    this.notice.set(undefined);
    const result = await changeRole(this.api, agencyId, member.userId, { role });
    this.savingRole.set(undefined);
    if (!result.ok) {
      // 409 LAST_AGENCY_ADMIN: the role stays as it was (Req 1.7); the selection is kept.
      this.rowError.set({
        userId: member.userId,
        message: this.api.errorMessage(result.error) ?? '',
      });
      return;
    }
    this.members.update((members) => upsertMember(members, result.value));
    this.clearDraft(member.userId);
    this.notice.set({
      key: 'portal.team.roleChanged',
      params: { name: result.value.displayName },
    });
  }

  protected async startRemoval(member: Member): Promise<void> {
    const agencyId = this.agencyId();
    if (agencyId === undefined) return;
    this.notice.set(undefined);
    this.removal.set({ member, dialog: { kind: 'loading' }, busy: false });
    const result = await previewRemoval(this.api, agencyId, member.userId);
    if (this.removal()?.member !== member) return;
    this.removal.set({
      member,
      busy: false,
      dialog: result.ok
        ? { kind: 'ready', impact: removalImpact(result.value) }
        : { kind: 'failed', message: this.api.errorMessage(result.error) ?? '' },
    });
  }

  protected async confirmRemoval(): Promise<void> {
    const agencyId = this.agencyId();
    const r = this.removal();
    if (agencyId === undefined || !r || r.busy) return;
    this.removal.set({ member: r.member, dialog: r.dialog, busy: true });
    const result = await removeMember(this.api, agencyId, r.member.userId);
    if (!result.ok) {
      const errorMessage = this.api.errorMessage(result.error);
      this.removal.set({
        member: r.member,
        dialog: r.dialog,
        busy: false,
        ...(errorMessage !== undefined && { errorMessage }),
      });
      return;
    }
    this.removal.set(undefined);
    this.members.update((members) => members.filter((m) => m.userId !== r.member.userId));
    this.clearDraft(r.member.userId);
    this.notice.set({ key: 'portal.team.removed', params: { name: r.member.displayName } });
  }

  private clearDraft(userId: string): void {
    this.drafts.update((drafts) =>
      Object.fromEntries(Object.entries(drafts).filter(([id]) => id !== userId)),
    );
  }

  private async load(pageToken?: string): Promise<void> {
    const agencyId = this.agencyId();
    if (agencyId === undefined) return;
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    this.loading.set(true);
    this.errorText.set(undefined);
    const result = await fetchMembers(this.api, agencyId, {
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
    this.members.update((members) => (pageToken === undefined ? items : [...members, ...items]));
    this.nextToken.set(result.value.nextPageToken);
  }
}
