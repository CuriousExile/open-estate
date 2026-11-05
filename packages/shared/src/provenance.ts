import type { Channel, Origin } from './management';
import { LISTING_BOUNDS, type Listing } from './schema/listing';

// Provenance fields and Öffentliche_Detail_URL (design: "Provenienzfelder und
// Öffentliche_Detail_URL", Req 4.5, 4.16, 4.17). The unchanged `Listing` schema requires
// `sourceUrl`, `source`, `lastImportedAt` and `lastRunId` for every origin; these functions
// derive them so every stored listing satisfies that schema.

/** Prefix of `source` for listings with origin `MANUAL`: `agency:{agencyId}` (Req 4.17). */
export const MANUAL_SOURCE_PREFIX = 'agency:';

function assertLength(
  field: string,
  value: string,
  bounds: { readonly min: number; readonly max: number },
): string {
  if (value.length < bounds.min || value.length > bounds.max) {
    throw new RangeError(
      `${field} must have ${bounds.min}–${bounds.max} characters, got ${value.length}`,
    );
  }
  return value;
}

/**
 * Öffentliche_Detail_URL `<origin>/listings/{id}` (Req 4.5); `origin` is the frontend origin
 * (scheme, host, port, no trailing slash).
 *
 * @throws RangeError if the URL violates `LISTING_BOUNDS.url`
 */
export function publicDetailUrl(origin: string, id: string): string {
  return assertLength(
    'sourceUrl',
    `${origin}/listings/${encodeURIComponent(id)}`,
    LISTING_BOUNDS.url,
  );
}

/** Listing side of the derivation: origin, current source and current owning agency. */
export interface ProvenanceListing {
  origin: Origin;
  /** Connector-Bezeichner for `IMPORT`; ignored for `MANUAL`. */
  source: string;
  agencyId?: string;
}

/** Write side: a new version or an import run without change. */
export interface ProvenanceWrite {
  channel: Channel;
  /** Version number of the (resulting) current version. */
  version: number;
  /** ISO-8601 time of the operation. */
  at: string;
  /** Connector_Lauf id; only set for imports. */
  runId?: string;
}

/**
 * Provenance fields after a write (Req 4.16, 4.17):
 * - `source`: connector id for `IMPORT`, `agency:{agencyId}` of the current owner for `MANUAL`
 * - `lastImportedAt`: time of the operation
 * - `lastRunId`: `runId` of the connector run, otherwise `{channel}#{version}` (e.g. `PORTAL#7`)
 *
 * @throws RangeError if a `MANUAL` listing has no agency or a derived value violates
 *   `LISTING_BOUNDS.source`/`LISTING_BOUNDS.runId`
 */
export function deriveProvenance(
  listing: ProvenanceListing,
  write: ProvenanceWrite,
): Pick<Listing, 'source' | 'lastImportedAt' | 'lastRunId'> {
  let source = listing.source;
  if (listing.origin === 'MANUAL') {
    if (listing.agencyId === undefined) {
      throw new RangeError('MANUAL listing without owning agency');
    }
    source = `${MANUAL_SOURCE_PREFIX}${listing.agencyId}`;
  }
  return {
    source: assertLength('source', source, LISTING_BOUNDS.source),
    lastImportedAt: write.at,
    lastRunId: assertLength(
      'lastRunId',
      write.runId ?? `${write.channel}#${write.version}`,
      LISTING_BOUNDS.runId,
    ),
  };
}
