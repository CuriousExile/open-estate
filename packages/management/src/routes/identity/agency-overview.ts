import {
  agencyScope,
  decodeKeyCursor,
  encodeKeyCursor,
  InvalidCursorError,
  LISTING_COUNTER_CODES,
  toAgencyView,
  type AgencyRecord,
  type AgencyStore,
  type KeyPage,
  type KeyPageRequest,
  type MembershipStore,
  type MetricCounterStore,
} from '@open-estate/core';
import {
  AGENCY_STATES,
  authorize,
  err,
  ok,
  type AgencyState,
  type AgencySummary,
  type ApiError,
  type Principal,
  type Result,
} from '@open-estate/shared';

// `GET /agencies`: agency overview of the Admin_Modus (Req 10.3) with members and listings per
// Listing_Status. Agencies are read per state (GSI `byState`, ordered by id): `ACTIVE` first, then
// `SUSPENDED`; the page token holds the state and the store cursor within it. Listing counts come
// from the exact `listing.status.*` counters the VersionedListingWriter keeps per agency.

export interface AgencyOverviewDeps {
  agencies: Pick<AgencyStore<unknown>, 'listByState'>;
  memberships: Pick<MembershipStore<unknown>, 'listByAgency'>;
  counters: Pick<MetricCounterStore<unknown>, 'get'>;
}

export interface AgencyOverviewQuery {
  state?: AgencyState;
  page: KeyPageRequest;
}

const MANAGE = 'agency:manage';
const COUNT_PAGE_SIZE = 100;

interface OverviewCursor {
  state: AgencyState;
  cursor?: string;
}

function encodeOverviewCursor({ state, cursor }: OverviewCursor): string {
  return encodeKeyCursor({ state, ...(cursor !== undefined && { cursor }) });
}

/** Throws `InvalidCursorError` for tokens not issued here (or for another `state` filter). */
function decodeOverviewCursor(token: string, states: readonly AgencyState[]): OverviewCursor {
  const { state, cursor } = decodeKeyCursor(token);
  const known = states.find((candidate) => candidate === state);
  if (known === undefined || (cursor !== undefined && typeof cursor !== 'string')) {
    throw new InvalidCursorError();
  }
  return { state: known, ...(cursor !== undefined && { cursor }) };
}

export class AgencyOverview {
  private readonly deps: AgencyOverviewDeps;

  constructor(deps: AgencyOverviewDeps) {
    this.deps = deps;
  }

  /** Plattform_Admins only (`agency:manage` platform-wide); throws `InvalidCursorError`. */
  async list(
    principal: Principal,
    { state, page }: AgencyOverviewQuery,
    signal?: AbortSignal,
  ): Promise<Result<KeyPage<AgencySummary>, ApiError[]>> {
    if (authorize(principal, MANAGE, undefined) !== 'ALLOW') {
      return err([{ code: 'FORBIDDEN', message: `Missing permission ${MANAGE}` }]);
    }
    const states = state === undefined ? AGENCY_STATES : [state];
    let position: OverviewCursor | undefined =
      page.cursor === undefined
        ? { state: states[0] ?? 'ACTIVE' }
        : decodeOverviewCursor(page.cursor, states);

    const records: AgencyRecord[] = [];
    while (position !== undefined && records.length < page.limit) {
      const result: KeyPage<AgencyRecord> = await this.deps.agencies.listByState(position.state, {
        limit: page.limit - records.length,
        ...(position.cursor !== undefined && { cursor: position.cursor }),
      });
      records.push(...result.items);
      position = this.next(states, position.state, result.nextCursor);
    }
    const items = await Promise.all(records.map((record) => this.summary(record, signal)));
    return ok({
      items,
      ...(position !== undefined && { nextCursor: encodeOverviewCursor(position) }),
    });
  }

  /** Continue in the same state, else at the start of the following one, else done. */
  private next(
    states: readonly AgencyState[],
    current: AgencyState,
    cursor: string | undefined,
  ): OverviewCursor | undefined {
    if (cursor !== undefined) return { state: current, cursor };
    const following = states[states.indexOf(current) + 1];
    return following === undefined ? undefined : { state: following };
  }

  private async summary(record: AgencyRecord, signal?: AbortSignal): Promise<AgencySummary> {
    const scope = agencyScope(record.agencyId);
    const [active, inactive, memberCount] = await Promise.all([
      this.deps.counters.get(scope, LISTING_COUNTER_CODES.status('ACTIVE'), undefined, signal),
      this.deps.counters.get(scope, LISTING_COUNTER_CODES.status('INACTIVE'), undefined, signal),
      this.countMembers(record.agencyId),
    ]);
    return {
      ...toAgencyView(record),
      memberCount,
      listingCounts: { ACTIVE: Math.max(0, active), INACTIVE: Math.max(0, inactive) },
    };
  }

  private async countMembers(agencyId: string): Promise<number> {
    let total = 0;
    let cursor: string | undefined;
    do {
      const page: KeyPage<unknown> = await this.deps.memberships.listByAgency(agencyId, {
        limit: COUNT_PAGE_SIZE,
        ...(cursor !== undefined && { cursor }),
      });
      total += page.items.length;
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return total;
  }
}
