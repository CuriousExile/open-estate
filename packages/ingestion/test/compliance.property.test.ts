// Feature: real-estate-platform, Property 20: Compliance-Gate (Default-deny)
import fc from 'fast-check';
import {
  DEFAULT_CRAWLER_USER_AGENT,
  REASON_ALLOWED,
  REASON_MISSING_LEGAL_BASIS,
  REASON_NOT_ALLOWLISTED,
  REASON_ROBOTS_DISALLOWED,
  REASON_ROBOTS_UNAVAILABLE,
  createComplianceChecker,
  createRunLogger,
  createWebCrawlerModule,
  productToken,
  type CrawlerFetch,
} from '@open-estate/ingestion';
import { createFakeClock } from './support/fake-clock';

/**
 * Property 20 on two levels: (1) the ComplianceChecker decision against an
 * independent reference model; (2) the web crawler end to end with a fake
 * fetch that records every request.
 *
 * **Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.7, 6.8, 6.9, 11.6, 11.7**
 */

const NOW = new Date('2026-11-05T10:00:00.000Z');
const ROBOTS_TIMEOUT_MS = 5;

/** Candidate allowlist origins with equivalent spellings the allowlist must normalize. */
const ORIGINS: Readonly<Record<string, readonly string[]>> = {
  'https://a.example': ['https://a.example', 'https://A.EXAMPLE', 'https://a.example:443/'],
  'https://b.example': ['https://b.example', 'https://b.example/'],
  'http://c.example:8080': ['http://c.example:8080', 'HTTP://C.example:8080/'],
};
/** Never on the allowlist; `www.a.example` guards against host prefix matching. */
const UNLISTED = ['https://evil.example', 'https://www.a.example', 'http://a.example'];
const ALL_ORIGINS = [...Object.keys(ORIGINS), ...UNLISTED];

const RULE_PATHS = ['/', '/a', '/a/', '/a/b', '/ab', '/private', '/private/x', '/p'];
const TARGET_PATHS = ['/', '/a', '/a/b', '/a/b/c', '/ab', '/private', '/private/x/1', '/public'];

const USER_AGENTS = [
  undefined,
  'AcmeBot/2.3 (+https://acme.example/bot)',
  'TestCrawler',
  'OpenEstateBot/1.0',
] as const;

type LegalBasis = string | null | undefined;
interface Rule {
  readonly allow: boolean;
  readonly path: string;
}
interface Group {
  readonly agents: readonly string[];
  readonly rules: readonly Rule[];
}
type RobotsBehavior =
  | { readonly kind: 'content'; readonly status: number; readonly groups: readonly Group[] }
  | { readonly kind: 'status'; readonly status: number }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'timeout' };
interface Entry {
  readonly canonical: string;
  readonly spelling: string;
  readonly legalBasis: LegalBasis;
}
interface Scenario {
  readonly userAgent: string | undefined;
  readonly entries: readonly Entry[];
  readonly robots: Readonly<Record<string, RobotsBehavior>>;
  readonly urls: readonly string[];
}

const arbLegalBasis: fc.Arbitrary<LegalBasis> = fc.oneof(
  fc.constantFrom('Lizenzvertrag LV-2025-07', 'Einwilligung Betreiber', ' Vertrag '),
  fc.constantFrom('', '   ', '\t', null, undefined),
);

/** Agent names: own token in two casings, `*` and a foreign bot (resolved per user agent). */
const arbAgent = fc.constantFrom('$TOKEN', '$token', '*', 'OtherBot');
const arbGroup: fc.Arbitrary<Group> = fc.record({
  agents: fc.uniqueArray(arbAgent, { minLength: 1, maxLength: 2 }),
  // ≥ 1 rule per group: an empty group would merge with the next User-agent lines.
  rules: fc.array(fc.record({ allow: fc.boolean(), path: fc.constantFrom(...RULE_PATHS) }), {
    minLength: 1,
    maxLength: 4,
  }),
});

const arbRobots: fc.Arbitrary<RobotsBehavior> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant('content' as const),
      status: fc.constantFrom(200, 203),
      groups: fc.array(arbGroup, { maxLength: 3 }),
    }),
  },
  fc.record({
    kind: fc.constant('status' as const),
    status: fc.constantFrom(301, 403, 404, 429, 500, 503),
  }),
  fc.record({ kind: fc.constant('error' as const), message: fc.constantFrom('ECONNRESET', 'DNS') }),
  fc.constant({ kind: 'timeout' as const }),
);

const arbEntries: fc.Arbitrary<Entry[]> = fc.subarray(Object.keys(ORIGINS)).chain((origins) =>
  fc.tuple(
    ...origins.map((canonical) =>
      fc.record({
        canonical: fc.constant(canonical),
        spelling: fc.constantFrom(...(ORIGINS[canonical] ?? [])),
        legalBasis: arbLegalBasis,
      }),
    ),
  ),
);

const arbUrl = fc
  .tuple(fc.constantFrom(...ALL_ORIGINS), fc.constantFrom(...TARGET_PATHS))
  .map(([origin, path]) => `${origin}${path}`);

const arbScenario: fc.Arbitrary<Scenario> = fc.record({
  userAgent: fc.constantFrom(...USER_AGENTS),
  entries: arbEntries,
  robots: fc.record(Object.fromEntries(ALL_ORIGINS.map((o) => [o, arbRobots]))),
  urls: fc.array(arbUrl, { minLength: 1, maxLength: 8 }),
});

const tokenOf = (s: Scenario): string => productToken(s.userAgent ?? DEFAULT_CRAWLER_USER_AGENT);

function resolveAgent(agent: string, token: string): string {
  if (agent === '$TOKEN') return token;
  if (agent === '$token') return token.toLowerCase();
  return agent;
}

function robotsText(groups: readonly Group[], token: string): string {
  return groups
    .map((g) =>
      [
        ...g.agents.map((a) => `User-agent: ${resolveAgent(a, token)}`),
        ...g.rules.map((r) => `${r.allow ? 'Allow' : 'Disallow'}: ${r.path}`),
      ].join('\n'),
    )
    .join('\n\n');
}

/**
 * Independent reference for the generated rule subset (no wildcards, no `$`):
 * rules of all groups naming the own token (case-insensitive) apply, else those
 * of `*` groups; plain prefix match, longest match wins, Allow wins ties, no
 * match → allowed.
 */
function robotsAllows(groups: readonly Group[], token: string, path: string): boolean {
  const rulesFor = (pred: (agent: string) => boolean) =>
    groups
      .filter((g) => g.agents.some((a) => pred(resolveAgent(a, token))))
      .flatMap((g) => g.rules);
  const own = rulesFor((a) => a.toLowerCase() === token.toLowerCase());
  const rules = own.length > 0 ? own : rulesFor((a) => a === '*');
  let best: Rule | undefined;
  for (const rule of rules) {
    if (!path.startsWith(rule.path)) continue;
    if (
      best === undefined ||
      rule.path.length > best.path.length ||
      (rule.path.length === best.path.length && rule.allow && !best.allow)
    ) {
      best = rule;
    }
  }
  return best?.allow ?? true;
}

interface Expected {
  readonly allowed: boolean;
  /** Exact reason, or the required prefix for robots.txt failures. */
  readonly reason: string;
  readonly exact: boolean;
  /** Fragment the robots.txt failure reason must contain (e.g. the HTTP status). */
  readonly detail?: string;
}

function model(s: Scenario, url: string): Expected {
  const { origin, pathname } = new URL(url);
  const entry = s.entries.find((e) => e.canonical === origin);
  if (entry === undefined) return { allowed: false, reason: REASON_NOT_ALLOWLISTED, exact: true };
  if (typeof entry.legalBasis !== 'string' || entry.legalBasis.trim() === '') {
    return { allowed: false, reason: REASON_MISSING_LEGAL_BASIS, exact: true };
  }
  const robots = s.robots[origin];
  if (robots === undefined) throw new Error(`no robots behavior for ${origin}`);
  switch (robots.kind) {
    case 'status':
      return {
        allowed: false,
        reason: REASON_ROBOTS_UNAVAILABLE,
        exact: false,
        detail: String(robots.status),
      };
    case 'error':
      return {
        allowed: false,
        reason: REASON_ROBOTS_UNAVAILABLE,
        exact: false,
        detail: robots.message,
      };
    case 'timeout':
      return { allowed: false, reason: REASON_ROBOTS_UNAVAILABLE, exact: false };
    case 'content':
      return robotsAllows(robots.groups, tokenOf(s), pathname)
        ? { allowed: true, reason: REASON_ALLOWED, exact: true }
        : { allowed: false, reason: REASON_ROBOTS_DISALLOWED, exact: true };
  }
}

function expectReason(actual: string, expected: Expected): void {
  if (expected.exact) {
    expect(actual).toBe(expected.reason);
    return;
  }
  expect(actual.startsWith(`${expected.reason}: `)).toBe(true);
  if (expected.detail !== undefined) expect(actual).toContain(expected.detail);
}

/** Fake web: robots.txt per origin as generated, pages always 200; records every request. */
function fakeWeb(s: Scenario) {
  const requests: string[] = [];
  const token = tokenOf(s);
  const fetch: CrawlerFetch = (url) => {
    requests.push(url);
    const { origin, pathname } = new URL(url);
    if (pathname !== '/robots.txt') {
      return Promise.resolve({ ok: true, status: 200, text: async () => '<html></html>' });
    }
    const robots = s.robots[origin];
    switch (robots?.kind) {
      case 'content':
        return Promise.resolve({
          ok: true,
          status: robots.status,
          text: async () => robotsText(robots.groups, token),
        });
      case 'status':
        return Promise.resolve({ ok: false, status: robots.status, text: async () => '' });
      case 'error':
        return Promise.reject(new Error(robots.message));
      default:
        // Timeout: never settles; the checker's deadline must decide.
        return new Promise<never>(() => undefined);
    }
  };
  return { fetch, requests };
}

const allowlistOf = (s: Scenario) => ({
  targets: s.entries.map((e) => ({ origin: e.spelling, legalBasis: e.legalBasis })),
});

const originOf = (url: string): string => new URL(url).origin;
const isRobots = (url: string): boolean => new URL(url).pathname === '/robots.txt';

describe('Property 20: Compliance-Gate (Default-deny)', () => {
  it('checker decision and reason match the reference model; no network for unlisted origins', async () => {
    await fc.assert(
      fc.asyncProperty(arbScenario, async (s) => {
        const web = fakeWeb(s);
        const checker = createComplianceChecker({
          allowlist: allowlistOf(s),
          ...(s.userAgent === undefined ? {} : { userAgent: s.userAgent }),
          fetch: web.fetch,
          now: () => NOW,
          timeoutMs: ROBOTS_TIMEOUT_MS,
        });
        for (const url of s.urls) {
          const decision = await checker.check(url);
          const expected = model(s, url);
          expect(decision.allowed).toBe(expected.allowed);
          expectReason(decision.reason, expected);
          expect(decision.checkedAt).toBe(NOW.toISOString());
        }
        const listed = new Set(s.entries.map((e) => e.canonical));
        for (const request of web.requests) {
          // The checker only ever reads robots.txt, and only for listed origins.
          expect(isRobots(request)).toBe(true);
          expect(listed.has(originOf(request))).toBe(true);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('crawler fetches a page iff the model allows it, robots.txt first, and logs every denial', async () => {
    await fc.assert(
      fc.asyncProperty(arbScenario, async (s) => {
        const web = fakeWeb(s);
        const module = createWebCrawlerModule({
          loadAllowlist: async () => allowlistOf(s),
          fetch: web.fetch,
          clock: createFakeClock(),
          now: () => NOW,
          robotsTimeoutMs: ROBOTS_TIMEOUT_MS,
        });
        const lines: string[] = [];
        const ctx = {
          config: module.settingsSchema.parse({
            startUrls: s.urls,
            ...(s.userAgent === undefined ? {} : { userAgent: s.userAgent }),
          }),
          runId: 'run-1',
          logger: createRunLogger({
            runId: 'run-1',
            source: 'partner-crawler',
            sink: (line) => lines.push(line),
            now: () => NOW,
          }),
          emit: async () => undefined,
        };
        const connector = module.create();
        await connector.initialize(ctx);
        await connector.run(ctx);

        const unique = [...new Set(s.urls)];
        const checks = lines
          .map((l) => JSON.parse(l) as Record<string, unknown>)
          .filter((e) => e['event'] === 'crawl.checked');
        expect(checks.map((c) => c['url'])).toEqual(unique);

        const pageRequests = web.requests.filter((r) => !isRobots(r));
        const expectedPages = unique.filter((url) => model(s, url).allowed);
        expect(pageRequests).toEqual(expectedPages);

        unique.forEach((url, i) => {
          const expected = model(s, url);
          const check = checks[i] ?? {};
          expect(check['result']).toBe(expected.allowed ? 'ALLOWED' : 'DENIED');
          expectReason(String(check['reason']), expected);
          expect(check['checkedAt']).toBe(NOW.toISOString());
        });

        // robots.txt of the same origin is requested before every page request.
        web.requests.forEach((request, i) => {
          if (isRobots(request)) return;
          const robotsUrl = `${originOf(request)}/robots.txt`;
          expect(web.requests.slice(0, i)).toContain(robotsUrl);
        });

        // No network access at all for origins that are not on the allowlist.
        const listed = new Set(s.entries.map((e) => e.canonical));
        for (const request of web.requests) expect(listed.has(originOf(request))).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});
