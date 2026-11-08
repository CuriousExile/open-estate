import { InvalidCursorError, type AgencyActor, type KeyPage } from '@open-estate/core';
import {
  CustomId,
  DiffQuery,
  EntityId,
  FLAG_CODES,
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENT_REPLAYED_HEADER,
  LISTING_BOUNDS,
  ListListingsQuery,
  ListVersionsQuery,
  VersionNumber,
  type ApiError,
  type Principal,
  type Result,
} from '@open-estate/shared';
import { z } from 'zod';
import { principalChannel } from '../handler';
import { failure, fromResult, success, type Reply } from '../http';
import { defineRoute, type Route } from '../router';
import type { RouteGroup } from './route-group';
import {
  createListingServices,
  type ListingServiceOptions,
  type ListingServices,
} from './listings/services';

// Listings and versions (design: "Management_API"): `/listings` (list, create), detail by id and
// by Custom_Id, content replacement, `/status`, `/agency`, `/versions`, `/diff`, `/restore`.
// Authorization, validation of the Listing_Inhalt and auditing live in the core use cases; the
// routes only parse path and query and map results. Command bodies are passed raw, because the
// PII filter of `prepareContent` has to see the content before validation (Req 4.10).
// Plattform_Admins choose the agency with `agencyId` (query of list and Custom_Id lookup, body of
// the creation); for agency actors it is always their own agency (Req 10.2, 10.4).

export * from './listings/services';

const ListingId = z.string().min(LISTING_BOUNDS.id.min).max(LISTING_BOUNDS.id.max);
const ListingParams = z.object({ id: ListingId });
const CustomIdParams = z.object({ customId: CustomId });
const FlagParams = z.object({ id: ListingId, code: z.enum(FLAG_CODES) });
const VersionParams = z.object({
  id: ListingId,
  n: z.preprocess((v) => (typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v), VersionNumber),
});
const AgencyQuery = z.object({ agencyId: EntityId.optional() });

const actorOf = (principal: Principal): AgencyActor => ({
  principal,
  channel: principalChannel(principal),
});

const invalidPageToken = (): ApiError => ({
  code: 'INVALID_PAGE_TOKEN',
  message: 'pageToken is invalid',
  field: 'pageToken',
});

/** Store page → API page (`nextCursor` → `nextPageToken`); a foreign cursor is a 400. */
async function paged<T>(read: () => Promise<Result<KeyPage<T>, ApiError[]>>): Promise<Reply> {
  try {
    const result = await read();
    if (!result.ok) return failure(result.error);
    const { items, nextCursor } = result.value;
    return success(200, { items, ...(nextCursor !== undefined && { nextPageToken: nextCursor }) });
  } catch (error) {
    if (error instanceof InvalidCursorError) return failure(invalidPageToken());
    throw error;
  }
}

const pageRequest = (q: { pageSize: number; pageToken?: string | undefined }) => ({
  limit: q.pageSize,
  ...(q.pageToken !== undefined && { cursor: q.pageToken }),
});

/** Throws once the request deadline passed, so no write starts after the 503 was sent. */
function ensureActive(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('Request aborted before the write');
}

/** The routes of the group over `services` (injectable for tests). */
export function createListingRoutes(services: ListingServices): Route[] {
  const { queries, versions } = services;
  const commands = async (signal: AbortSignal) => {
    const loaded = await services.commands();
    ensureActive(signal);
    return loaded;
  };

  return [
    defineRoute({
      method: 'GET',
      path: '/listings',
      query: ListListingsQuery,
      handle: ({ principal, query }) => {
        // A lookup by ids (the schema allows no other filter with it).
        if (query.ids !== undefined) {
          const ids = query.ids;
          return paged(() => queries.lookup(actorOf(principal), ids));
        }
        const { status, origin, offerType, listingType, customId, q, agencyId, flag } = query;
        const filter = {
          ...(agencyId !== undefined && { agencyId }),
          ...(flag !== undefined && { flag }),
          ...(status !== undefined && { status }),
          ...(origin !== undefined && { origin }),
          ...(offerType !== undefined && { offerType }),
          ...(listingType !== undefined && { listingType }),
          ...(customId !== undefined && { customId }),
          ...(q !== undefined && { titleQuery: q }),
        };
        return paged(() => queries.list(actorOf(principal), filter, pageRequest(query)));
      },
    }),
    defineRoute({
      method: 'POST',
      path: '/listings',
      // With `Idempotency-Key`, a repetition answers with the listing it created (Req 9.2–9.6
      // of duplicate-detection); the service validates the key format (400 on the header).
      handle: async ({ principal, body, signal, header }) => {
        const service = await commands(signal);
        const key = header(IDEMPOTENCY_KEY_HEADER);
        if (key === undefined) return fromResult(201, await service.create(principal, body));
        const created = await service.createWithKey(principal, body, key);
        if (!created.ok) return failure(created.error);
        return {
          ...success(201, created.value.view),
          ...(created.value.replayed && { headers: { [IDEMPOTENT_REPLAYED_HEADER]: 'true' } }),
        };
      },
    }),
    defineRoute({
      method: 'GET',
      path: '/listings/by-custom-id/{customId}',
      params: CustomIdParams,
      query: AgencyQuery,
      handle: async ({ principal, params, query }) =>
        fromResult(
          200,
          await queries.getByCustomId(actorOf(principal), params.customId, query.agencyId),
        ),
    }),
    defineRoute({
      method: 'GET',
      path: '/listings/{id}',
      params: ListingParams,
      handle: async ({ principal, params }) =>
        fromResult(200, await queries.get(actorOf(principal), params.id)),
    }),
    defineRoute({
      method: 'PUT',
      path: '/listings/{id}',
      params: ListingParams,
      handle: async ({ principal, params, body, signal }) =>
        fromResult(200, await (await commands(signal)).replaceContent(principal, params.id, body)),
    }),
    defineRoute({
      method: 'PUT',
      path: '/listings/{id}/status',
      params: ListingParams,
      handle: async ({ principal, params, body, signal }) =>
        fromResult(200, await (await commands(signal)).setStatus(principal, params.id, body)),
    }),
    defineRoute({
      method: 'PUT',
      path: '/listings/{id}/agency',
      params: ListingParams,
      handle: async ({ principal, params, body, signal }) =>
        fromResult(200, await (await commands(signal)).assignAgency(principal, params.id, body)),
    }),
    defineRoute({
      method: 'DELETE',
      path: '/listings/{id}/flags/{code}',
      params: FlagParams,
      // Verwerfen einer Markierung (duplicate-detection Req 8.2, 8.4): no version, status stays.
      handle: async ({ principal, params, signal }) =>
        fromResult(
          200,
          await (await commands(signal)).dismissFlag(principal, params.id, params.code),
        ),
    }),
    defineRoute({
      method: 'GET',
      path: '/listings/{id}/versions',
      params: ListingParams,
      query: ListVersionsQuery,
      handle: ({ principal, params, query }) =>
        paged(() => versions.list(actorOf(principal), params.id, pageRequest(query))),
    }),
    defineRoute({
      method: 'GET',
      path: '/listings/{id}/versions/{n}',
      params: VersionParams,
      handle: async ({ principal, params }) =>
        fromResult(200, await versions.get(actorOf(principal), params.id, params.n)),
    }),
    defineRoute({
      method: 'GET',
      path: '/listings/{id}/diff',
      params: ListingParams,
      query: DiffQuery,
      handle: async ({ principal, params, query }) =>
        fromResult(200, await versions.diff(actorOf(principal), params.id, query.from, query.to)),
    }),
    defineRoute({
      method: 'POST',
      path: '/listings/{id}/restore',
      params: ListingParams,
      handle: async ({ principal, params, body, signal }) =>
        fromResult(200, await (await commands(signal)).restore(principal, params.id, body)),
    }),
  ];
}

/** Listing route group; `options` inject the S3 client (tests). */
export function createListingRouteGroup(options: ListingServiceOptions = {}): RouteGroup {
  return {
    name: 'listings',
    create: (context) => createListingRoutes(createListingServices(context, options)),
  };
}

export const listingRoutes: RouteGroup = createListingRouteGroup();
