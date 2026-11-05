// Framework-free logic of the public detail route `/listings/:id` (design: Öffentliche_Detail_URL;
// Req 4.19). Kept free of Angular imports so it can be unit-tested with plain Jest.
import type { LocalizedListing } from '@open-estate/shared';
import type { ApiResult } from '../api/api-client';

/** Translation key and parameters of a human-readable error message. */
export interface ListingPageMessage {
  readonly key: string;
  readonly params?: Readonly<Record<string, number>>;
}

/** What the detail route shows. */
export type ListingPageState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'found'; readonly listing: LocalizedListing }
  /** Unknown or not public listing — Search_API answers both alike (Req 4.19). */
  | { readonly kind: 'not-found' }
  /** The listing could not be loaded; retrying may help. */
  | { readonly kind: 'error'; readonly message: ListingPageMessage };

/**
 * State for the answer of `GET /listings/{id}`; `undefined` if the request was cancelled (a newer
 * id replaced it). 404 and 400 (malformed id) mean the same to the visitor: nothing to show here.
 */
export function toListingPageState(
  result: ApiResult<LocalizedListing>,
): ListingPageState | undefined {
  if (result.ok) return { kind: 'found', listing: result.value };
  const error = result.error;
  switch (error.kind) {
    case 'aborted':
      return undefined;
    case 'timeout':
      return {
        kind: 'error',
        message: { key: 'listingPage.error.timeout', params: { seconds: error.timeoutMs / 1000 } },
      };
    case 'network':
      return { kind: 'error', message: { key: 'listingPage.error.network' } };
    case 'invalid-response':
      return { kind: 'error', message: { key: 'listingPage.error.server' } };
    case 'api':
      if (error.status === 404 || error.status === 400) return { kind: 'not-found' };
      if (error.status === 429) {
        return {
          kind: 'error',
          message:
            error.retryAfterSeconds === undefined
              ? { key: 'listingPage.error.rateLimited' }
              : {
                  key: 'listingPage.error.rateLimitedRetry',
                  params: { seconds: error.retryAfterSeconds },
                },
        };
      }
      return { kind: 'error', message: { key: 'listingPage.error.server' } };
  }
}
