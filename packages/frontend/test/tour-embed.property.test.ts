// Feature: real-estate-platform, Property 19: Tour-Einbettung nur für aktuell erlaubte Hosts
import fc from 'fast-check';
import {
  assertValidTaxonomy,
  DEFAULT_TAXONOMY_CONFIG,
  serialize,
  type LocalizedListing,
} from '@open-estate/shared';
import { arbListing, arbLocalizedVersion } from '../../shared/test/arbitraries';
import { toListingDetail } from '../src/app/listing/listing-detail-model';
import {
  createTourRejectionReporter,
  planTourEmbeds,
  toAllowedTourHosts,
  type TourEmbedView,
  type TourRejection,
  type TourRejectionLogger,
} from '../src/app/listing/tour-embed-model';

/**
 * Property 19: for any listing and any tour allowlist loaded at display time, the detail view
 * embeds exactly the tours whose host is allowed (case-insensitive, exact); all other content is
 * still rendered, and every tour that is not embedded is logged with listing ID and host.
 *
 * The expectation is built structurally from the generated parts (scheme, userinfo, port,
 * canonical host, path) and from how the allowlist entries were generated (bare host from the
 * pool vs. junk), so it does not reuse `URL` parsing or the model's allowlist filter.
 *
 * **Validates: Requirements 16.6, 16.7**
 */

const taxonomy = assertValidTaxonomy(DEFAULT_TAXONOMY_CONFIG);
const LOCALES = ['de', 'en', 'fr', 'pt-BR'] as const;

/** Host as written in a tour URL, and its canonical form (lower-case ASCII, IDN as punycode). */
interface PoolHost {
  readonly display: string;
  readonly canonical: string;
}

const HOST_POOL: readonly PoolHost[] = [
  { display: 'my.matterport.com', canonical: 'my.matterport.com' },
  { display: 'sub.my.matterport.com', canonical: 'sub.my.matterport.com' },
  { display: 'matterport.com', canonical: 'matterport.com' },
  { display: 'my.matterport.com.', canonical: 'my.matterport.com.' },
  { display: 'my.matterport.com.evil.example', canonical: 'my.matterport.com.evil.example' },
  { display: 'tour.example', canonical: 'tour.example' },
  { display: 'bücher.example', canonical: 'xn--bcher-kva.example' },
  { display: 'xn--bcher-kva.example', canonical: 'xn--bcher-kva.example' },
  { display: 'evil.example', canonical: 'evil.example' },
];
const CANONICAL_HOSTS = [...new Set(HOST_POOL.map((h) => h.canonical))];

/** Path as written and as it appears in the normalized `href`. */
const PATHS: readonly (readonly [string, string])[] = [
  ['', '/'],
  ['/', '/'],
  ['/show/?m=abc', '/show/?m=abc'],
  ['/tour/1', '/tour/1'],
  ['/t?x=1#frag', '/t?x=1#frag'],
];

/** Unparseable or non-network URLs with the host `URL` reports for them. */
const JUNK_URLS: readonly (readonly [string, string | null])[] = [
  ['not a url', null],
  ['/relative/tour', null],
  ['javascript:alert(1)', ''],
  ['data:text/html,<p>x</p>', ''],
];

/** Allowlist entries that are not bare host names and therefore never match. */
const JUNK_ENTRIES = [
  'https://my.matterport.com',
  'my.matterport.com:8443',
  '*.matterport.com',
  'user@tour.example',
  'tour.example/path',
  'bücher.example',
  ' tour.example',
  '',
];

const arbRandomCase = (s: string): fc.Arbitrary<string> =>
  fc
    .array(fc.boolean(), { minLength: s.length, maxLength: s.length })
    .map((upper) => [...s].map((c, i) => (upper[i] ? c.toUpperCase() : c)).join(''));

type TourCase =
  | {
      readonly kind: 'structured';
      readonly scheme: 'https' | 'http';
      readonly userinfo: '' | 'user@' | 'user:pw@';
      readonly port: '' | ':443' | ':8443';
      readonly canonical: string;
      readonly hrefPath: string;
      readonly url: string;
      readonly providerCode: string;
    }
  | {
      readonly kind: 'junk';
      readonly host: string | null;
      readonly url: string;
      readonly providerCode: string;
    };

const arbProviderCode = fc.constantFrom('matterport', 'other', 'p-1');

const arbStructuredTour: fc.Arbitrary<TourCase> = fc
  .record({
    // Mostly the embeddable shape, so allowed hosts are exercised often.
    scheme: fc.constantFrom<'https' | 'http'>('https', 'https', 'https', 'http'),
    userinfo: fc.constantFrom<'' | 'user@' | 'user:pw@'>('', '', '', 'user@', 'user:pw@'),
    port: fc.constantFrom<'' | ':443' | ':8443'>('', '', '', ':443', ':8443'),
    host: fc
      .constantFrom(...HOST_POOL)
      .chain((h) => arbRandomCase(h.display).map((display) => ({ ...h, display }))),
    path: fc.constantFrom(...PATHS),
    providerCode: arbProviderCode,
  })
  .map(({ scheme, userinfo, port, host, path: [rawPath, hrefPath], providerCode }) => ({
    kind: 'structured',
    scheme,
    userinfo,
    port,
    canonical: host.canonical,
    hrefPath,
    url: `${scheme}://${userinfo}${host.display}${port}${rawPath}`,
    providerCode,
  }));

const arbJunkTour: fc.Arbitrary<TourCase> = fc
  .record({ junk: fc.constantFrom(...JUNK_URLS), providerCode: arbProviderCode })
  .map(({ junk: [url, host], providerCode }) => ({ kind: 'junk', url, host, providerCode }));

const arbTours = fc.array(fc.oneof({ weight: 9, arbitrary: arbStructuredTour }, arbJunkTour), {
  maxLength: 10,
});

/** Raw `/meta.tourProviders` and the canonical hosts it allows by construction. */
interface Allowlist {
  readonly raw: readonly string[];
  readonly allowed: ReadonlySet<string>;
}

const arbAllowlist: fc.Arbitrary<Allowlist> = fc
  .tuple(
    fc.subarray(CANONICAL_HOSTS).chain((hosts) => fc.tuple(...hosts.map((h) => arbRandomCase(h)))),
    fc.subarray(JUNK_ENTRIES),
  )
  .chain(([bare, junk]) =>
    fc
      .shuffledSubarray([...bare, ...junk], {
        minLength: bare.length + junk.length,
      })
      .map((raw) => ({ raw, allowed: new Set(bare.map((h) => h.toLowerCase())) })),
  );

/** Expected decision of one tour against the allowed canonical hosts. */
function expectedDecision(
  tour: TourCase,
  allowed: ReadonlySet<string>,
): { embed: true; url: string } | { embed: false; host: string | null } {
  if (tour.kind === 'junk') return { embed: false, host: tour.host };
  const defaultPort = tour.port === '' || (tour.port === ':443' && tour.scheme === 'https');
  const embeddable =
    tour.scheme === 'https' && tour.userinfo === '' && defaultPort && allowed.has(tour.canonical);
  if (embeddable) return { embed: true, url: `https://${tour.canonical}${tour.hrefPath}` };
  return { embed: false, host: defaultPort ? tour.canonical : `${tour.canonical}${tour.port}` };
}

interface Input {
  readonly listing: LocalizedListing;
  readonly tours: readonly TourCase[];
  readonly locale: string;
  readonly first: Allowlist;
  readonly second: Allowlist;
}

const arbInput: fc.Arbitrary<Input> = fc.tuple(arbListing(), arbTours).chain(([base, tours]) => {
  const internal = {
    ...base,
    tours: tours.map(({ url, providerCode }) => ({ url, providerCode })),
  };
  return fc.record({
    listing: arbLocalizedVersion(internal).map((version) =>
      serialize(internal, { taxonomy, version }),
    ),
    tours: fc.constant(tours),
    locale: fc.constantFrom(...LOCALES),
    first: arbAllowlist,
    second: arbAllowlist,
  });
});

describe('Property 19: Tour-Einbettung nur für aktuell erlaubte Hosts', () => {
  it('embeds exactly the allowed tours, keeps all other content and logs each hidden tour', () => {
    fc.assert(
      fc.property(arbInput, ({ listing, tours, locale, first, second }) => {
        const snapshot = structuredClone(listing);
        const log: jest.MockedFunction<TourRejectionLogger> = jest.fn();
        const report = createTourRejectionReporter(log);
        const detailBefore = toListingDetail(listing, locale);

        // Display time 1, 2 and 1 again: each plan follows the allowlist loaded at that moment.
        const renders = [first, second, first].map((allowlist) => {
          const plan = planTourEmbeds(listing.id, listing.tours, toAllowedTourHosts(allowlist.raw));
          const expected = tours.map((tour) => expectedDecision(tour, allowlist.allowed));

          const expectedEmbeds: TourEmbedView[] = [];
          const expectedRejections: { listingId: string; host: string | null }[] = [];
          expected.forEach((decision, index) => {
            if (decision.embed) {
              const providerCode = tours[index]?.providerCode ?? '';
              expectedEmbeds.push({ index, url: decision.url, providerCode });
            } else expectedRejections.push({ listingId: listing.id, host: decision.host });
          });

          expect(plan.embeds).toEqual(expectedEmbeds);
          expect(plan.rejections.map(({ listingId, host }) => ({ listingId, host }))).toEqual(
            expectedRejections,
          );

          report(plan.rejections);
          return plan;
        });

        // One log entry per distinct (listingId, host) among the hidden tours, in first-seen order.
        const expectedLogs = new Map<string, TourRejection>();
        for (const { rejections } of renders) {
          for (const rejection of rejections) {
            const key = JSON.stringify([rejection.listingId, rejection.host]);
            if (!expectedLogs.has(key)) expectedLogs.set(key, rejection);
          }
        }
        expect(log.mock.calls).toEqual(
          [...expectedLogs.values()].map((fields) => ['tour not embedded', fields]),
        );

        // All other content is rendered regardless of the allowlist; tours are passed through.
        const detailAfter = toListingDetail(listing, locale);
        expect(detailAfter).toEqual(detailBefore);
        expect(detailAfter.tours).toEqual(snapshot.tours);
        expect(detailAfter.media).toEqual(snapshot.media);
        expect(detailAfter.offers).toHaveLength(snapshot.offers.length);
        expect(detailAfter.sections.length).toBeGreaterThan(0);
        expect(listing).toEqual(snapshot);
      }),
      { numRuns: 100 },
    );
  });
});
