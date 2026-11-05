// Framework-free model and Management_API call of the agency's Audit_Log (Req 11.4, 11.5): the API
// returns only entries of the caller's agency, newest first, filtered by actor, action and period.
import { AuditEntry, AuditLogQuery, MANAGEMENT_BOUNDS, page } from '@open-estate/shared';
import { z } from 'zod';
import type { ManagementCaller } from '../shared/management-caller';

export type AuditRecord = z.output<typeof AuditEntry>;
const AuditPage = page(AuditEntry);

/** Filter inputs as typed; `from`/`to` are UTC calendar days (`YYYY-MM-DD`), `''` = no filter. */
export interface AuditFilterValues {
  actor: string;
  action: string;
  from: string;
  to: string;
}

export const EMPTY_AUDIT_FILTERS: AuditFilterValues = { actor: '', action: '', from: '', to: '' };

export type AuditFilterField = keyof AuditFilterValues;
const FIELDS: readonly AuditFilterField[] = ['actor', 'action', 'from', 'to'];

export interface AuditFilterError {
  readonly field: AuditFilterField;
  readonly messageKey: string;
  readonly params?: Readonly<Record<string, number>>;
}

/** Query parameters of `GET /audit-log`; empty filters are omitted. */
export type AuditQuery = Partial<Record<AuditFilterField, string>>;

const DAY_MS = 86_400_000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Start of a UTC day in ms; NaN for malformed or rolled-over dates (e.g. 2026-02-31). */
function dayStart(day: string): number {
  if (!DAY.test(day)) return NaN;
  const ms = Date.parse(`${day}T00:00:00.000Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === day ? ms : NaN;
}

const errorFor = (field: AuditFilterField): AuditFilterError =>
  field === 'actor'
    ? { field, messageKey: 'portal.audit.error.text', params: { ...MANAGEMENT_BOUNDS.id } }
    : field === 'action'
      ? { field, messageKey: 'portal.audit.error.text', params: { ...MANAGEMENT_BOUNDS.action } }
      : { field, messageKey: 'portal.audit.error.date' };

/**
 * Validates the filters with the API's query schema. `from` starts at 00:00 UTC, `to` includes
 * the whole day; `from` after `to` is reported on `from`.
 */
export function validateAuditFilters(
  values: AuditFilterValues,
): { ok: true; query: AuditQuery } | { ok: false; errors: AuditFilterError[] } {
  const query: AuditQuery = {};
  const failed = new Map<AuditFilterField, AuditFilterError>();
  const actor = values.actor.trim();
  const action = values.action.trim();
  if (actor !== '') query.actor = actor;
  if (action !== '') query.action = action;
  for (const field of ['from', 'to'] as const) {
    const day = values[field].trim();
    if (day === '') continue;
    const start = dayStart(day);
    if (Number.isNaN(start)) failed.set(field, errorFor(field));
    else query[field] = new Date(field === 'from' ? start : start + DAY_MS - 1).toISOString();
  }
  if (failed.size === 0) {
    const result = AuditLogQuery.safeParse(query);
    if (!result.success) {
      for (const issue of result.error.issues) {
        const field = issue.path[0];
        if (typeof field !== 'string' || !(FIELDS as readonly string[]).includes(field)) continue;
        const name = field as AuditFilterField;
        const reversed = (issue as { params?: { code?: string } }).params?.code === 'INVALID_RANGE';
        failed.set(
          name,
          reversed ? { field: name, messageKey: 'portal.audit.error.reversed' } : errorFor(name),
        );
      }
    }
  }
  if (failed.size > 0) return { ok: false, errors: FIELDS.flatMap((f) => failed.get(f) ?? []) };
  return { ok: true, query };
}

/** `GET /audit-log` (Req 11.5): the API restricts agency actors to their own agency. */
export const fetchAuditLog = (
  api: ManagementCaller,
  query: AuditQuery,
  { pageToken, signal }: { pageToken?: string; signal?: AbortSignal } = {},
) =>
  api.get('/audit-log', {
    query: { ...query, pageToken },
    ...(signal && { signal }),
    parse: (value) => AuditPage.parse(value),
  });

/** Display of the Akteur: kind as translation key plus name and identifier. */
export interface ActorDisplay {
  readonly kindKey: string;
  readonly name: string;
  readonly id: string | undefined;
}

export function actorDisplay(actor: AuditRecord['actor']): ActorDisplay | undefined {
  if (actor === undefined) return undefined;
  const kindKey = `portal.audit.actorKind.${actor.kind}`;
  switch (actor.kind) {
    case 'user':
      return { kindKey, name: actor.displayName, id: actor.userId };
    case 'machine':
      return { kindKey, name: actor.label, id: actor.keyId };
    case 'connector':
      return { kindKey, name: actor.connectorId, id: actor.runId };
    case 'iam':
      return { kindKey, name: actor.userArn, id: undefined };
  }
}

/** `success` and other non-error results are shown neutral; denials and failures highlighted. */
export const isFailureResult = (result: string): boolean => result.toLowerCase() !== 'success';

export const channelKey = (channel: string): string => `portal.audit.channel.${channel}`;
