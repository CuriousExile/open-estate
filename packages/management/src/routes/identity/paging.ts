import { InvalidCursorError, type KeyPage, type KeyPageRequest } from '@open-estate/core';
import { ListVersionsQuery } from '@open-estate/shared';
import { failure, type Reply } from '../../http';

// Pagination of the identity routes: the API's `pageSize`/`pageToken` (shared schema) map onto
// the stores' key pages; a page token the store did not issue is a 400 `INVALID_PAGE_TOKEN`.

/** `pageSize` / `pageToken` query of every paged identity route (same bounds as all lists). */
export const PageQuery = ListVersionsQuery;
export type PageQuery = ListVersionsQuery;

export interface ApiPage<T> {
  items: T[];
  nextPageToken?: string;
}

export const toKeyPageRequest = ({ pageSize, pageToken }: PageQuery): KeyPageRequest => ({
  limit: pageSize,
  ...(pageToken !== undefined && { cursor: pageToken }),
});

export const toApiPage = <T>({ items, nextCursor }: KeyPage<T>): ApiPage<T> => ({
  items,
  ...(nextCursor !== undefined && { nextPageToken: nextCursor }),
});

export const invalidPageToken = (): Reply =>
  failure({ code: 'INVALID_PAGE_TOKEN', message: 'Invalid page token', field: 'pageToken' });

/** Runs a paged read; an `InvalidCursorError` becomes 400 `INVALID_PAGE_TOKEN`. */
export async function withPageToken(read: () => Promise<Reply>): Promise<Reply> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof InvalidCursorError) return invalidPageToken();
    throw error;
  }
}
