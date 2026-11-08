// Framework-free logic of the listing workspace (design: Agentur_Portal → ListingWorkspaceComponent;
// Req 5.8, 7.8, 8.6, 12.15). Kept free of Angular imports so it can be unit-tested with plain Jest.
import {
  resolvePreferences,
  selectLocalizedVersion,
  serialize,
  type ActorRef,
  type ChangedPath,
  type Listing,
  type ListingView,
  type LocalizedListing,
  type Taxonomy,
  type VersionEntry,
} from '@open-estate/shared';
import type { z } from 'zod';

/** `GET /listings/{id}` after parsing: Listing_Inhalt in the internal representation (minor units). */
export type ParsedListingView = z.output<typeof ListingView>;
/** History entry after parsing. */
export type ParsedVersionEntry = z.output<typeof VersionEntry>;
export type ParsedChangedPath = z.output<typeof ChangedPath>;

/**
 * Model of the portal preview (Req 5.8): exactly what the public detail view receives from the
 * Search_API for the same listing with Listing_Status `ACTIVE` — the stored listing serialized in
 * the language version the API would select for `locale` (same `lang` → preferences → selection →
 * `serialize` as the Search_API). The status is ignored on purpose; the rendering itself is done by
 * the unchanged `ListingDetailComponent`/`toListingDetail`.
 */
export function toPublicDetailModel(
  view: ParsedListingView,
  locale: string,
  taxonomy: Taxonomy,
): LocalizedListing {
  const listing: Listing = {
    ...view.content,
    id: view.id,
    source: view.source,
    lastImportedAt: view.lastImportedAt,
    lastRunId: view.lastRunId,
  };
  // The Search_API rejects an invalid `lang`; the portal falls back to the original language.
  const prefs =
    locale === '' ? { ok: true as const, value: [] } : resolvePreferences({ lang: locale });
  const version = selectLocalizedVersion(listing, prefs.ok ? prefs.value : []);
  return serialize(listing, { taxonomy, version });
}

/** Display of an Akteur (Req 7.9): kind label via `portal.workspace.actorKind.<kind>` plus data. */
export interface ActorView {
  readonly kindKey: string;
  /** Name, label, connector or IAM identity — data, shown as delivered. */
  readonly name: string;
  /** Connector_Lauf of a connector actor. */
  readonly runId?: string;
}

export function toActorView(actor: ActorRef): ActorView {
  const kindKey = `portal.workspace.actorKind.${actor.kind}`;
  switch (actor.kind) {
    case 'user':
      return { kindKey, name: actor.displayName };
    case 'machine':
      return { kindKey, name: actor.label };
    case 'connector':
      return { kindKey, name: actor.connectorId, runId: actor.runId };
    case 'iam':
      return { kindKey, name: actor.userArn };
    case 'system':
      return { kindKey, name: actor.job, runId: actor.runId };
  }
}

/** Translation keys of the code values shown in the workspace. */
export const channelKey = (channel: string): string => `portal.workspace.channel.${channel}`;
export const changeTypeKey = (type: string): string => `portal.workspace.changeType.${type}`;
export const statusKey = (status: string): string => `portal.workspace.status.${status}`;
export const originKey = (origin: string): string => `portal.workspace.origin.${origin}`;

/** The workspace tabs (design: Vorschau, Feldherkunft, Historie). */
export const WORKSPACE_TABS = ['preview', 'provenance', 'history'] as const;
export type WorkspaceTab = (typeof WORKSPACE_TABS)[number];
