import {
  authorize,
  err,
  ok,
  type ApiError,
  type ListingSummary,
  type ListingView,
  type Principal,
  type Result,
} from '@open-estate/shared';
import {
  AgencyAuditTrail,
  decisionError,
  notFound,
  type AgencyActor,
  type AgencyAudit,
} from './agency-audit';
import type { KeyPage, KeyPageRequest } from './key-page';
import type { ListingKeyStore } from './listing-key-store';
import type {
  ManagedListing,
  ManagedListingFilter,
  ManagedListingQueryStore,
  ManagedListingStore,
} from './listing-store';
import { toListingView } from './listing-view';
import { NO_AGENCY_SCOPE_ID } from './metric-counter-store';

// Read use cases of `/listings` (design: "Management_API", Req 2.7, 4.13, 4.14, 10.4). Reads are
// audited only when rejected (Req 2.8): FORBIDDEN as `access-denied`, NOT_FOUND as `management`.

/** Audit actions of the listing and version reads. */
export type ListingReadAction =
  'listing.get' | 'listing.list' | 'version.list' | 'version.get' | 'version.diff';

export type ListingReadResult<T> = Result<T, ApiError[]>;

const LISTING_READ = 'listing:read';

export const listingTarget = (listingId: string) => `listing/${listingId}`;

/**
 * Loads a listing the principal may read: `NOT_FOUND` if it does not exist or belongs to another
 * agency (Req 2.6), `FORBIDDEN` without `listing:read` (Req 2.5); independent of the status.
 */
export async function readableListing(
  listings: Pick<ManagedListingStore<unknown>, 'get'>,
  principal: Principal,
  listingId: string,
): Promise<Result<ManagedListing, ApiError>> {
  const managed = await listings.get(listingId);
  if (managed === null) return err(notFound());
  const decision = authorize(principal, LISTING_READ, managed.management.agencyId ?? null);
  const denied = decisionError(decision, LISTING_READ);
  return denied === null ? ok(managed) : err(denied);
}

/** Agency of an agency actor; `undefined` for Plattform_Admins. */
export function ownAgency(principal: Principal): string | undefined {
  if (principal.kind === 'machine') return principal.agencyId;
  return principal.role === 'PLATFORM_ADMIN' ? undefined : principal.agencyId;
}

/** Row of the listing overview (Req 5.2): title of the original language version. */
export function toListingSummary({ listing, management }: ManagedListing): ListingSummary {
  return {
    id: listing.id,
    title: listing.title,
    status: management.status,
    origin: management.origin,
    ...(management.customId !== undefined && { customId: management.customId }),
    ...(management.agencyId !== undefined && { agencyId: management.agencyId }),
    offerTypes: listing.offers.map((offer) => offer.offerType),
    listingType: listing.listingType,
    version: management.version,
    updatedAt: management.updatedAt,
  };
}

export interface ListingQueryServiceDeps {
  listings: Pick<ManagedListingStore<unknown>, 'get'> & ManagedListingQueryStore;
  keys: Pick<ListingKeyStore<unknown>, 'get'>;
  audit: AgencyAudit;
  /** Frontend origin for `sourceUrlDerived` (`publicDetailUrl`, Req 4.5). */
  frontendOrigin: string;
}

export class ListingQueryService {
  private readonly deps: ListingQueryServiceDeps;
  private readonly trail: AgencyAuditTrail<ListingReadAction>;

  constructor(deps: ListingQueryServiceDeps) {
    this.deps = deps;
    this.trail = new AgencyAuditTrail<ListingReadAction>(deps.audit);
  }

  /** `GET /listings/{id}` (Req 4.13, 6.6). */
  async get(actor: AgencyActor, listingId: string): Promise<ListingReadResult<ListingView>> {
    const found = await readableListing(this.deps.listings, actor.principal, listingId);
    if (!found.ok) {
      return this.trail.reject(
        actor,
        'listing.get',
        listingTarget(listingId),
        undefined,
        found.error,
      );
    }
    return ok(toListingView(found.value, this.deps.frontendOrigin));
  }

  /**
   * `GET /listings/by-custom-id/{customId}` (Req 4.13). Agency actors look up within their own
   * agency; Plattform_Admins pass `agencyId`, without it the Custom_Ids of listings without agency.
   */
  async getByCustomId(
    actor: AgencyActor,
    customId: string,
    agencyId?: string,
  ): Promise<ListingReadResult<ListingView>> {
    const { principal } = actor;
    const owner = agencyId ?? ownAgency(principal);
    const target = `listing/by-custom-id/${customId}`;
    const denied = decisionError(authorize(principal, LISTING_READ, owner ?? null), LISTING_READ);
    if (denied !== null) return this.trail.reject(actor, 'listing.get', target, owner, denied);

    const listingId = await this.deps.keys.get(owner ?? NO_AGENCY_SCOPE_ID, customId);
    const found =
      listingId === null
        ? err(notFound())
        : await readableListing(this.deps.listings, principal, listingId);
    // A key pointing to a listing that no longer carries this Custom_Id is treated as absent.
    if (!found.ok || found.value.management.customId !== customId) {
      return this.trail.reject(
        actor,
        'listing.get',
        target,
        owner,
        found.ok ? notFound() : found.error,
      );
    }
    return ok(toListingView(found.value, this.deps.frontendOrigin));
  }

  /**
   * `GET /listings` (Req 4.14, 10.4). Agency actors always list their own agency — the agency is
   * the key condition of the store query, not a later filter (Req 2.7); another `agencyId` is
   * `NOT_FOUND`. Plattform_Admins may filter by agency or list all listings.
   */
  async list(
    actor: AgencyActor,
    filter: ManagedListingFilter,
    page: KeyPageRequest,
  ): Promise<ListingReadResult<KeyPage<ListingSummary>>> {
    const { principal } = actor;
    const agencyId = filter.agencyId ?? ownAgency(principal);
    const denied = decisionError(authorize(principal, LISTING_READ, agencyId), LISTING_READ);
    if (denied !== null)
      return this.trail.reject(actor, 'listing.list', 'listing', agencyId, denied);

    // `agencyId` is undefined only for a Plattform_Admin without agency filter.
    const scoped = agencyId === undefined ? filter : { ...filter, agencyId };
    const result = await this.deps.listings.query(scoped, page);
    return ok({ ...result, items: result.items.map(toListingSummary) });
  }

  /**
   * `GET /listings?ids=` (e.g. one page of search results, for the manage controls of the SPA):
   * the listings among `ids` the principal may read, in the given order, in one page. Unknown ids
   * and listings of other agencies are left out, exactly as if they did not exist (Req 2.6); like
   * `list`, only a missing `listing:read` is refused (and audited).
   */
  async lookup(
    actor: AgencyActor,
    ids: readonly string[],
  ): Promise<ListingReadResult<KeyPage<ListingSummary>>> {
    const { principal } = actor;
    const agencyId = ownAgency(principal);
    const denied = decisionError(authorize(principal, LISTING_READ, agencyId), LISTING_READ);
    if (denied !== null)
      return this.trail.reject(actor, 'listing.list', 'listing', agencyId, denied);

    const found = await Promise.all(
      [...new Set(ids)].map((id) => readableListing(this.deps.listings, principal, id)),
    );
    return ok({
      items: found.flatMap((result) => (result.ok ? [toListingSummary(result.value)] : [])),
    });
  }
}
