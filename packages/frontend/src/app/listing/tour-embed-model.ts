// Framework-free logic of the tour embed (design: TourEmbedComponent; Req 16.6, 16.7).
// Kept free of Angular imports so it can be unit-tested with plain Jest.
import type { LocalizedListing } from '@open-estate/shared';

type Tour = LocalizedListing['tours'][number];

/** Same shape as the server-side `tour-providers.json` host names: ASCII (IDN as punycode). */
const BARE_HOSTNAME = /^[a-z0-9.-]+$/;

/**
 * Allowed tour hosts from `/meta.tourProviders`, lower-cased. Entries that are not a bare host
 * name (scheme, port, path, userinfo, wildcard) are dropped, so they can never match. Missing
 * `/meta` → empty set → nothing is embedded (default-deny).
 */
export function toAllowedTourHosts(
  tourProviders: readonly string[] | undefined,
): ReadonlySet<string> {
  return new Set(
    (tourProviders ?? [])
      .map((host) => host.toLowerCase())
      .filter((host) => BARE_HOSTNAME.test(host)),
  );
}

export type TourRejectionReason =
  'INVALID_URL' | 'NOT_HTTPS' | 'USERINFO' | 'PORT' | 'HOST_NOT_ALLOWED';

export type TourDecision =
  | { readonly embed: true; readonly url: string; readonly host: string }
  | {
      readonly embed: false;
      readonly reason: TourRejectionReason;
      /** `host[:port]` of the URL, `null` if it cannot be parsed. */
      readonly host: string | null;
    };

/**
 * Whether a tour URL may be embedded: absolute `https:` URL without userinfo, on the default
 * port, whose host name equals an allowed host exactly (case-insensitive; no subdomains, no
 * trailing-dot variant). `URL` lower-cases the host and converts IDNs to punycode, so the comparison
 * runs on the same form as the allowlist. On success `url` is the normalized `href` — the only
 * value that may later be marked as trusted.
 */
export function decideTourEmbed(rawUrl: string, allowedHosts: ReadonlySet<string>): TourDecision {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { embed: false, reason: 'INVALID_URL', host: null };
  }
  const reject = (reason: TourRejectionReason): TourDecision => ({
    embed: false,
    reason,
    host: url.host,
  });
  if (url.protocol !== 'https:') return reject('NOT_HTTPS');
  if (url.username !== '' || url.password !== '') return reject('USERINFO');
  // `URL` drops the default port (443), so any remaining port is a non-default one.
  if (url.port !== '') return reject('PORT');
  if (!allowedHosts.has(url.hostname)) return reject('HOST_NOT_ALLOWED');
  return { embed: true, url: url.href, host: url.hostname };
}

export interface TourEmbedView {
  /** Position in the listing's tour list; stable `track` key. */
  readonly index: number;
  /** Normalized URL that passed {@link decideTourEmbed}. */
  readonly url: string;
  readonly providerCode: string;
}

export interface TourRejection {
  readonly listingId: string;
  readonly host: string | null;
  readonly reason: TourRejectionReason;
}

export interface TourEmbedPlan {
  /** Tours to embed, in stored order. */
  readonly embeds: readonly TourEmbedView[];
  /** Tours that are hidden (Req 16.7). */
  readonly rejections: readonly TourRejection[];
}

/** Splits a listing's tours into embeddable and hidden ones against the current allowlist. */
export function planTourEmbeds(
  listingId: string,
  tours: readonly Tour[],
  allowedHosts: ReadonlySet<string>,
): TourEmbedPlan {
  const embeds: TourEmbedView[] = [];
  const rejections: TourRejection[] = [];
  tours.forEach((tour, index) => {
    const decision = decideTourEmbed(tour.url, allowedHosts);
    if (decision.embed) embeds.push({ index, url: decision.url, providerCode: tour.providerCode });
    else rejections.push({ listingId, host: decision.host, reason: decision.reason });
  });
  return { embeds, rejections };
}

export type TourRejectionLogger = (
  message: string,
  fields: { listingId: string; host: string | null; reason: TourRejectionReason },
) => void;

/**
 * Logs each hidden tour once per listing and host for the lifetime of the returned function, so
 * re-rendering or reopening a listing does not repeat the entry (Req 16.7).
 */
export function createTourRejectionReporter(
  log: TourRejectionLogger,
): (rejections: readonly TourRejection[]) => void {
  const seen = new Set<string>();
  return (rejections) => {
    for (const { listingId, host, reason } of rejections) {
      const key = JSON.stringify([listingId, host]);
      if (seen.has(key)) continue;
      seen.add(key);
      log('tour not embedded', { listingId, host, reason });
    }
  };
}
