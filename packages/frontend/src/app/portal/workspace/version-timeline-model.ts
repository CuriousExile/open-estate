// Framework-free logic of the version timeline (design: VersionTimelineComponent; Req 7.5, 7.8).
import { toActorView, type ActorView, type ParsedVersionEntry } from './workspace-model';

/** One version on the timeline (newest first, as delivered by the Management_API). */
export interface TimelineItem {
  readonly version: number;
  readonly createdAt: string;
  readonly changeType: ParsedVersionEntry['changeType'];
  readonly channel: ParsedVersionEntry['channel'];
  readonly actor: ActorView;
  readonly status: ParsedVersionEntry['status'];
  /** Änderungskanal `IMPORT`: shown as Listenimport (Req 7.8). */
  readonly isImport: boolean;
  /** Connector and Connector_Lauf of a Listenimport (Req 7.8, 7.9). */
  readonly connector?: { readonly connectorId: string; readonly runId: string };
  readonly restoredFrom?: number;
  /** Changed Inhaltsfelder of the version. */
  readonly changedPaths: readonly string[];
  /** Fields this import overwrote after a manual change (Req 12.11). */
  readonly overwrittenPaths: readonly string[];
  /** The listing's current version. */
  readonly current: boolean;
  /**
   * Stored INACTIVE although requested otherwise: automatically deactivated as a possible
   * duplicate of `originalId` (duplicate-detection Req 5.4, 13.4).
   */
  readonly autoDeactivated?: { readonly originalId: string };
}

export function toTimelineItem(entry: ParsedVersionEntry, currentVersion: number): TimelineItem {
  const isImport = entry.channel === 'IMPORT';
  return {
    version: entry.version,
    createdAt: entry.createdAt,
    changeType: entry.changeType,
    channel: entry.channel,
    actor: toActorView(entry.actor),
    status: entry.status,
    isImport,
    ...(isImport &&
      entry.actor.kind === 'connector' && {
        connector: { connectorId: entry.actor.connectorId, runId: entry.actor.runId },
      }),
    ...(entry.restoredFrom !== undefined && { restoredFrom: entry.restoredFrom }),
    changedPaths: entry.changedPaths.map((c) => c.path),
    overwrittenPaths: entry.changedPaths.filter((c) => c.overwrittenByImport).map((c) => c.path),
    current: entry.version === currentVersion,
    ...(entry.statusReason?.code === 'DUPLICATE' && {
      autoDeactivated: { originalId: entry.statusReason.originalId },
    }),
  };
}

/** Appends a further page; versions already shown are not repeated, order stays newest first. */
export function mergeVersionPages(
  shown: readonly ParsedVersionEntry[],
  page: readonly ParsedVersionEntry[],
): ParsedVersionEntry[] {
  const byVersion = new Map(shown.map((e) => [e.version, e]));
  for (const entry of page) byVersion.set(entry.version, entry);
  return [...byVersion.values()].sort((a, b) => b.version - a.version);
}

/** Maximum number of versions selected for comparison (Req 7.8: two). */
export const MAX_COMPARE = 2;

/**
 * Toggles `version` in the comparison selection: deselects it if selected, otherwise adds it and
 * drops the earliest selection when a third version is chosen.
 */
export function toggleCompare(selected: readonly number[], version: number): number[] {
  if (selected.includes(version)) return selected.filter((v) => v !== version);
  return [...selected, version].slice(-MAX_COMPARE);
}

/** Diff direction of a complete selection: from the older to the newer version. */
export function comparePair(selected: readonly number[]): { from: number; to: number } | undefined {
  if (selected.length !== MAX_COMPARE) return undefined;
  const [a, b] = selected as [number, number];
  return a === b ? undefined : { from: Math.min(a, b), to: Math.max(a, b) };
}

/** A version can be restored if it is not the current one and the user may restore (Req 5.6, 8.1). */
export function canRestore(item: TimelineItem, mayRestore: boolean): boolean {
  return mayRestore && !item.current;
}
