// Framework-free logic of the field provenance view (design: FieldProvenanceComponent; Req 7.2,
// 12.11, 12.15).
import { contentPaths, type FieldSource } from '@open-estate/shared';
import {
  toActorView,
  type ActorView,
  type ParsedListingView,
  type ParsedVersionEntry,
} from './workspace-model';

/** Changed paths of a version, as far as the provenance view needs them. */
export type HistoryLookup = ReadonlyMap<number, Pick<ParsedVersionEntry, 'changedPaths'>>;

export interface FieldSourceView {
  readonly channel: FieldSource['channel'];
  readonly actor: ActorView;
  readonly version: number;
}

/** One Inhaltsfeld with its Feldherkunft (Req 12.15). */
export interface ProvenanceRow {
  /** Content path, e.g. `address.city` or `offers`. */
  readonly path: string;
  /** Absent only if the Management_API sent no Feldherkunft for the path. */
  readonly source?: FieldSourceView;
  /**
   * Last changed by a Listenimport that overwrote a manual change (Req 12.11, 12.15): `true`/`false`
   * once the version that set the field is known, `undefined` while it is still being loaded.
   */
  readonly overwrittenByImport: boolean | undefined;
  /** Feldherkunft before that import, if it overwrote a manual change. */
  readonly previous?: FieldSourceView;
}

const toSourceView = (source: FieldSource): FieldSourceView => ({
  channel: source.channel,
  actor: toActorView(source.actor),
  version: source.version,
});

/**
 * Rows for every present content path (and every path with a Feldherkunft), sorted. A field is
 * highlighted if its Feldherkunft is a Listenimport whose version marked it as "durch Listenimport
 * überschrieben" — that version knows whether the import replaced a manual change.
 */
export function fieldProvenanceRows(
  view: Pick<ParsedListingView, 'content' | 'fieldSources'>,
  history: HistoryLookup,
): ProvenanceRow[] {
  const paths = [
    ...new Set([...contentPaths(view.content), ...Object.keys(view.fieldSources)]),
  ].sort();
  return paths.map((path): ProvenanceRow => {
    const source = view.fieldSources[path];
    if (source === undefined) return { path, overwrittenByImport: false };
    if (source.channel !== 'IMPORT') {
      return { path, source: toSourceView(source), overwrittenByImport: false };
    }
    const entry = history.get(source.version);
    if (entry === undefined) {
      return { path, source: toSourceView(source), overwrittenByImport: undefined };
    }
    const changed = entry.changedPaths.find((c) => c.path === path);
    const overwritten = changed?.overwrittenByImport === true;
    return {
      path,
      source: toSourceView(source),
      overwrittenByImport: overwritten,
      ...(overwritten &&
        changed.previous !== undefined && { previous: toSourceView(changed.previous) }),
    };
  });
}

/**
 * Import versions referenced by the Feldherkunft but not yet in `history`, ascending: the
 * workspace loads them (`GET /versions/{n}`) to decide the highlighting.
 */
export function missingImportVersions(
  fieldSources: ParsedListingView['fieldSources'],
  history: HistoryLookup,
): number[] {
  const versions = new Set<number>();
  for (const source of Object.values(fieldSources)) {
    if (source.channel === 'IMPORT' && !history.has(source.version)) versions.add(source.version);
  }
  return [...versions].sort((a, b) => a - b);
}
