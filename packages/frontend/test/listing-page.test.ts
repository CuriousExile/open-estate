import fc from 'fast-check';
import type { LocalizedListing } from '@open-estate/shared';
import de from '../public/i18n/de.json';
import en from '../public/i18n/en.json';
import type { ClientError } from '../src/app/api/api-client';
import { toListingPageState } from '../src/app/listing/listing-page-model';

const listing = { id: 'l-1', title: 'Loft' } as LocalizedListing;
const fail = (error: ClientError) => toListingPageState({ ok: false, error });

describe('toListingPageState (Req 4.19)', () => {
  it('shows the delivered listing', () => {
    expect(toListingPageState({ ok: true, value: listing })).toEqual({ kind: 'found', listing });
  });

  it('shows "not found" for unknown or not public listings (404) and malformed ids (400)', () => {
    expect(fail({ kind: 'api', status: 404, errors: [] })).toEqual({ kind: 'not-found' });
    expect(fail({ kind: 'api', status: 400, errors: [] })).toEqual({ kind: 'not-found' });
  });

  it('ignores a cancelled request', () => {
    expect(fail({ kind: 'aborted' })).toBeUndefined();
  });

  it('maps transport and server failures to retryable error messages', () => {
    expect(fail({ kind: 'timeout', timeoutMs: 10_000 })).toEqual({
      kind: 'error',
      message: { key: 'listingPage.error.timeout', params: { seconds: 10 } },
    });
    expect(fail({ kind: 'network', message: 'offline' })).toEqual({
      kind: 'error',
      message: { key: 'listingPage.error.network' },
    });
    expect(fail({ kind: 'invalid-response', status: 200, message: 'x' })).toEqual({
      kind: 'error',
      message: { key: 'listingPage.error.server' },
    });
    expect(fail({ kind: 'api', status: 503, errors: [] })).toEqual({
      kind: 'error',
      message: { key: 'listingPage.error.server' },
    });
    expect(fail({ kind: 'api', status: 429, errors: [], retryAfterSeconds: 7 })).toEqual({
      kind: 'error',
      message: { key: 'listingPage.error.rateLimitedRetry', params: { seconds: 7 } },
    });
    expect(fail({ kind: 'api', status: 429, errors: [] })).toEqual({
      kind: 'error',
      message: { key: 'listingPage.error.rateLimited' },
    });
  });

  it('never shows a listing for a failed request, and every message key is translated', () => {
    const keys = [Object.keys(en), Object.keys(de)].map((list) => new Set(list));
    fc.assert(
      fc.property(fc.integer({ min: 300, max: 599 }), (status) => {
        const state = fail({ kind: 'api', status, errors: [] });
        expect(state?.kind).not.toBe('found');
        if (state?.kind === 'error') {
          for (const locale of keys) expect(locale.has(state.message.key)).toBe(true);
        }
      }),
    );
  });
});
