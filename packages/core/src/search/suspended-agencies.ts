import { ACCESS_CACHE_TTL_MS, systemClock, TtlCache, type Clock } from '../access/ttl-cache';
import { DOWNSTREAM_DEADLINE_MS } from '../deadlines';
import type { AgencyStore } from '../management/agency-store';
import { ServiceUnavailableError } from './service-unavailable-error';

// Agency suspension at query time (design: "Öffentliche Sichtbarkeit", Req 1.9): the read side
// loads the set of suspended agencies from GSI `byState` and caches it for 60 s, so a suspension
// or reactivation takes effect within 60 s without reindexing.

/** Current set of suspended agency ids. */
export interface SuspendedAgencies {
  current(): Promise<ReadonlySet<string>>;
}

/** No agency is suspended (local development, tests without agencies). */
export const NO_SUSPENDED_AGENCIES: SuspendedAgencies = {
  current: async () => new Set<string>(),
};

/** Page size of one `byState` query while loading the set. */
export const SUSPENDED_AGENCIES_PAGE_LIMIT = 1000;

export interface CachedSuspendedAgenciesOptions {
  store: Pick<AgencyStore<unknown>, 'listByState'>;
  clock?: Clock;
  ttlMs?: number;
  /** Deadline of one load across all pages (Req 9.6); defaults to `DOWNSTREAM_DEADLINE_MS`. */
  deadlineMs?: number;
}

/** Rejects once `ms` elapse; the timer is cleared as soon as `work` settles. */
async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`deadline of ${ms} ms exceeded`)), ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reads all pages of `listByState('SUSPENDED')`. A failed load is not cached and surfaces as
 * {@link ServiceUnavailableError} (503, no partial result — Req 9.5).
 */
export function createCachedSuspendedAgencies({
  store,
  clock = systemClock,
  ttlMs = ACCESS_CACHE_TTL_MS,
  deadlineMs = DOWNSTREAM_DEADLINE_MS,
}: CachedSuspendedAgenciesOptions): SuspendedAgencies {
  const cache = new TtlCache<'suspended', ReadonlySet<string>>(clock, ttlMs, 1);
  const readAll = async (): Promise<ReadonlySet<string>> => {
    const ids = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await store.listByState('SUSPENDED', {
        limit: SUSPENDED_AGENCIES_PAGE_LIMIT,
        ...(cursor !== undefined && { cursor }),
      });
      for (const agency of page.items) ids.add(agency.agencyId);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return ids;
  };
  const load = async (): Promise<ReadonlySet<string>> => {
    try {
      return await withDeadline(readAll(), deadlineMs);
    } catch (cause) {
      throw new ServiceUnavailableError('Suspended agencies could not be loaded', { cause });
    }
  };
  return { current: () => cache.get('suspended', load) };
}
