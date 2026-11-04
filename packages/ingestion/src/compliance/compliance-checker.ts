import robotsParser from 'robots-parser';
import { normalizeOrigin } from './crawler-allowlist';

/** Result of a compliance check for one target URL (Req 6.7, 11.7). */
export interface ComplianceDecision {
  readonly allowed: boolean;
  readonly reason: string;
  /** ISO-8601 timestamp with offset (UTC, `Z`) of the decision. */
  readonly checkedAt: string;
}

export interface ComplianceChecker {
  check(url: string): Promise<ComplianceDecision>;
}

/** Decision reasons; robots.txt failures are prefixed with {@link REASON_ROBOTS_UNAVAILABLE}. */
export const REASON_INVALID_URL = 'ungültige URL';
export const REASON_UNSUPPORTED_SCHEME = 'nicht unterstütztes URL-Schema';
export const REASON_NOT_ALLOWLISTED = 'nicht auf Erlaubnisliste';
export const REASON_MISSING_LEGAL_BASIS = 'fehlende Rechtsgrundlage';
export const REASON_ROBOTS_UNAVAILABLE = 'robots.txt nicht abrufbar';
export const REASON_ROBOTS_DISALLOWED = 'robots.txt untersagt Pfad';
export const REASON_ALLOWED = 'zulässig';

/** Upper bound for fetching robots.txt, including the body (Req 6.2). */
export const ROBOTS_TIMEOUT_MS = 10_000;

/**
 * Fallback User-Agent. Operators are expected to override it via
 * configuration with their own product token and contact URL.
 */
export const DEFAULT_CRAWLER_USER_AGENT =
  'OpenEstateBot/0.0 (+https://github.com/CuriousExile/open-estate)';

/** The subset of the WHATWG fetch API the checker needs; injectable for tests. */
export type RobotsFetch = (
  url: string,
  init: { readonly signal: AbortSignal; readonly headers: Readonly<Record<string, string>> },
) => Promise<{ readonly ok: boolean; readonly status: number; text(): Promise<string> }>;

/** Allowlist entry as seen by the checker; `legalBasis` may be absent or blank (Req 6.9). */
export interface ComplianceTarget {
  readonly origin: string;
  readonly legalBasis?: string | null | undefined;
}

export interface ComplianceCheckerOptions {
  readonly allowlist: { readonly targets: readonly ComplianceTarget[] };
  /** Full User-Agent header; its product token selects the robots.txt group. */
  readonly userAgent?: string;
  readonly fetch?: RobotsFetch;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
}

type Robots = ReturnType<typeof robotsParser>;
type RobotsResult = { readonly robots: Robots } | { readonly failure: string };

/**
 * robots.txt group selector: the product token of the User-Agent, e.g.
 * `OpenEstateBot` for `OpenEstateBot/1.0 (+https://…)`. robots-parser only
 * strips a `/version` suffix, so a bare token is passed explicitly.
 */
export function productToken(userAgent: string): string {
  const first = userAgent.trim().split(/\s+/)[0] ?? '';
  return first.split('/')[0] ?? '';
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Default-deny compliance gate (Req 6.1–6.4, 6.7–6.9, 11.7). Rules are
 * evaluated in fixed order, the first matching one decides:
 *
 * 1. invalid or non-http(s) URL, or origin not on the allowlist → deny without network access;
 * 2. missing/blank legal basis → deny;
 * 3. robots.txt timeout (10 s), network error or non-2xx → deny (stricter than RFC 9309);
 * 4. path disallowed by robots.txt for the configured User-Agent → deny;
 * 5. otherwise allow.
 *
 * robots.txt is fetched at most once per origin per instance — create one
 * checker per crawl run so each run re-reads robots.txt.
 */
export function createComplianceChecker(options: ComplianceCheckerOptions): ComplianceChecker {
  const userAgent = options.userAgent ?? DEFAULT_CRAWLER_USER_AGENT;
  const token = productToken(userAgent);
  if (token === '') throw new Error('crawler User-Agent must not be blank');
  const fetchRobots: RobotsFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? ROBOTS_TIMEOUT_MS;

  const targets = new Map<string, ComplianceTarget>();
  for (const target of options.allowlist.targets) {
    const origin = normalizeOrigin(target.origin);
    if (origin !== undefined && !targets.has(origin)) targets.set(origin, target);
  }
  const robotsCache = new Map<string, Promise<RobotsResult>>();

  const decide = (allowed: boolean, reason: string): ComplianceDecision => ({
    allowed,
    reason,
    checkedAt: now().toISOString(),
  });

  async function loadRobots(origin: string): Promise<RobotsResult> {
    const robotsUrl = `${origin}/robots.txt`;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`Zeitüberschreitung nach ${timeoutMs} ms`);
        controller.abort(error);
        reject(error);
      }, timeoutMs);
    });
    try {
      // The race also bounds fetch implementations that ignore the signal.
      return await Promise.race([
        (async (): Promise<RobotsResult> => {
          const response = await fetchRobots(robotsUrl, {
            signal: controller.signal,
            headers: { 'User-Agent': userAgent },
          });
          if (!response.ok) return { failure: `HTTP ${response.status}` };
          return { robots: robotsParser(robotsUrl, await response.text()) };
        })(),
        deadline,
      ]);
    } catch (error) {
      return { failure: describeError(error) };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async check(url) {
      let target: URL;
      try {
        target = new URL(url);
      } catch {
        return decide(false, REASON_INVALID_URL);
      }
      if (target.protocol !== 'http:' && target.protocol !== 'https:') {
        return decide(false, REASON_UNSUPPORTED_SCHEME);
      }

      const entry = targets.get(target.origin);
      if (entry === undefined) return decide(false, REASON_NOT_ALLOWLISTED);
      if (typeof entry.legalBasis !== 'string' || entry.legalBasis.trim() === '') {
        return decide(false, REASON_MISSING_LEGAL_BASIS);
      }

      let pending = robotsCache.get(target.origin);
      if (pending === undefined) {
        pending = loadRobots(target.origin);
        robotsCache.set(target.origin, pending);
      }
      const result = await pending;
      if ('failure' in result) {
        return decide(false, `${REASON_ROBOTS_UNAVAILABLE}: ${result.failure}`);
      }
      // `undefined` (URL outside the robots.txt origin) counts as not allowed.
      if (result.robots.isAllowed(target.href, token) !== true) {
        return decide(false, REASON_ROBOTS_DISALLOWED);
      }
      return decide(true, REASON_ALLOWED);
    },
  };
}
