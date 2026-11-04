import {
  createComplianceChecker,
  DEFAULT_CRAWLER_USER_AGENT,
  productToken,
  REASON_ALLOWED,
  REASON_INVALID_URL,
  REASON_MISSING_LEGAL_BASIS,
  REASON_NOT_ALLOWLISTED,
  REASON_ROBOTS_DISALLOWED,
  REASON_ROBOTS_UNAVAILABLE,
  REASON_UNSUPPORTED_SCHEME,
  type ComplianceCheckerOptions,
  type ComplianceTarget,
  type RobotsFetch,
} from '@open-estate/ingestion';

const ORIGIN = 'https://partner.example';
const FIXED_NOW = new Date('2026-11-05T10:00:00.000Z');

type Reply = { status: number; body?: string } | Error | 'hang';

/** Fake fetch recording calls; replies per robots.txt URL. */
function fakeFetch(replies: Record<string, Reply>) {
  const calls: { url: string; headers: Readonly<Record<string, string>> }[] = [];
  const fetch: RobotsFetch = (url, init) => {
    calls.push({ url, headers: init.headers });
    const reply = replies[url] ?? { status: 404 };
    if (reply === 'hang') {
      return new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason));
      });
    }
    if (reply instanceof Error) return Promise.reject(reply);
    return Promise.resolve({
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      text: () => Promise.resolve(reply.body ?? ''),
    });
  };
  return { fetch, calls };
}

function checker(
  replies: Record<string, Reply>,
  targets: readonly ComplianceTarget[] = [{ origin: ORIGIN, legalBasis: 'Lizenzvertrag LV-1' }],
  extra: Partial<ComplianceCheckerOptions> = {},
) {
  const fake = fakeFetch(replies);
  const instance = createComplianceChecker({
    allowlist: { targets },
    fetch: fake.fetch,
    now: () => FIXED_NOW,
    ...extra,
  });
  return { instance, calls: fake.calls };
}

const robots = (body: string): Record<string, Reply> => ({
  [`${ORIGIN}/robots.txt`]: { status: 200, body },
});

describe('createComplianceChecker', () => {
  it('allows an allowlisted URL whose path robots.txt permits', async () => {
    const { instance, calls } = checker(robots('User-agent: *\nDisallow: /private'));
    await expect(instance.check(`${ORIGIN}/listings/1`)).resolves.toEqual({
      allowed: true,
      reason: REASON_ALLOWED,
      checkedAt: '2026-11-05T10:00:00.000Z',
    });
    expect(calls).toEqual([
      { url: `${ORIGIN}/robots.txt`, headers: { 'User-Agent': DEFAULT_CRAWLER_USER_AGENT } },
    ]);
  });

  it.each([
    ['not a url', REASON_INVALID_URL],
    ['ftp://partner.example/file', REASON_UNSUPPORTED_SCHEME],
    ['https://other.example/listings', REASON_NOT_ALLOWLISTED],
    ['http://partner.example/listings', REASON_NOT_ALLOWLISTED],
    ['https://partner.example:8443/listings', REASON_NOT_ALLOWLISTED],
  ])('denies %s without network access', async (url, reason) => {
    const { instance, calls } = checker(robots(''));
    await expect(instance.check(url)).resolves.toMatchObject({ allowed: false, reason });
    expect(calls).toHaveLength(0);
  });

  it('matches origins case-insensitively and ignores default ports', async () => {
    const { instance } = checker(robots(''), [
      { origin: 'HTTPS://Partner.Example:443', legalBasis: 'LV-1' },
    ]);
    await expect(instance.check('https://PARTNER.example/x')).resolves.toMatchObject({
      allowed: true,
    });
  });

  it.each([
    ['missing', {}],
    ['null', { legalBasis: null }],
    ['empty', { legalBasis: '' }],
    ['blank', { legalBasis: ' \t ' }],
  ])('denies a %s legal basis before fetching robots.txt', async (_, basis) => {
    const { instance, calls } = checker(robots(''), [{ origin: ORIGIN, ...basis }]);
    await expect(instance.check(`${ORIGIN}/x`)).resolves.toMatchObject({
      allowed: false,
      reason: REASON_MISSING_LEGAL_BASIS,
    });
    expect(calls).toHaveLength(0);
  });

  it.each([404, 401, 403, 500, 503, 301])('denies when robots.txt answers %i', async (status) => {
    const { instance } = checker({ [`${ORIGIN}/robots.txt`]: { status } });
    await expect(instance.check(`${ORIGIN}/x`)).resolves.toMatchObject({
      allowed: false,
      reason: `${REASON_ROBOTS_UNAVAILABLE}: HTTP ${status}`,
    });
  });

  it('denies on a network error', async () => {
    const { instance } = checker({ [`${ORIGIN}/robots.txt`]: new Error('ECONNREFUSED') });
    await expect(instance.check(`${ORIGIN}/x`)).resolves.toMatchObject({
      allowed: false,
      reason: `${REASON_ROBOTS_UNAVAILABLE}: ECONNREFUSED`,
    });
  });

  it('denies when robots.txt does not arrive before the deadline', async () => {
    const { instance } = checker({ [`${ORIGIN}/robots.txt`]: 'hang' }, undefined, {
      timeoutMs: 20,
    });
    const decision = await instance.check(`${ORIGIN}/x`);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(
      new RegExp(`^${REASON_ROBOTS_UNAVAILABLE}: Zeitüberschreitung`),
    );
  });

  it('bounds fetch implementations that ignore the abort signal', async () => {
    const instance = createComplianceChecker({
      allowlist: { targets: [{ origin: ORIGIN, legalBasis: 'LV-1' }] },
      fetch: () => new Promise(() => undefined),
      timeoutMs: 20,
    });
    await expect(instance.check(`${ORIGIN}/x`)).resolves.toMatchObject({ allowed: false });
  });

  it('denies a path disallowed by robots.txt', async () => {
    const { instance } = checker(robots('User-agent: *\nDisallow: /private\nAllow: /private/ok'));
    await expect(instance.check(`${ORIGIN}/private/a`)).resolves.toMatchObject({
      allowed: false,
      reason: REASON_ROBOTS_DISALLOWED,
    });
    await expect(instance.check(`${ORIGIN}/private/ok`)).resolves.toMatchObject({
      allowed: true,
    });
  });

  it('applies the robots.txt group of the configured User-Agent', async () => {
    const body = [
      'User-agent: *',
      'Disallow: /',
      '',
      'User-agent: AcmeCrawler',
      'Disallow: /private',
    ].join('\n');
    const acme = checker(robots(body), undefined, {
      userAgent: 'AcmeCrawler/2.1 (+https://acme.example/bot)',
    });
    await expect(acme.instance.check(`${ORIGIN}/listings`)).resolves.toMatchObject({
      allowed: true,
    });
    await expect(acme.instance.check(`${ORIGIN}/private`)).resolves.toMatchObject({
      allowed: false,
      reason: REASON_ROBOTS_DISALLOWED,
    });
    expect(acme.calls[0]?.headers['User-Agent']).toBe(
      'AcmeCrawler/2.1 (+https://acme.example/bot)',
    );

    const other = checker(robots(body));
    await expect(other.instance.check(`${ORIGIN}/listings`)).resolves.toMatchObject({
      allowed: false,
      reason: REASON_ROBOTS_DISALLOWED,
    });
  });

  it('fetches robots.txt once per origin per instance, including failures', async () => {
    const second = 'https://second.example';
    const { instance, calls } = checker(
      { ...robots(''), [`${second}/robots.txt`]: { status: 500 } },
      [
        { origin: ORIGIN, legalBasis: 'LV-1' },
        { origin: second, legalBasis: 'LV-2' },
      ],
    );
    await Promise.all([instance.check(`${ORIGIN}/a`), instance.check(`${ORIGIN}/b`)]);
    await instance.check(`${ORIGIN}/c`);
    await instance.check(`${second}/a`);
    await instance.check(`${second}/b`);
    expect(calls.map((c) => c.url)).toEqual([`${ORIGIN}/robots.txt`, `${second}/robots.txt`]);

    const nextRunFetch = fakeFetch(robots(''));
    const nextRun = createComplianceChecker({
      allowlist: { targets: [{ origin: ORIGIN, legalBasis: 'LV-1' }] },
      fetch: nextRunFetch.fetch,
    });
    await nextRun.check(`${ORIGIN}/a`);
    expect(nextRunFetch.calls).toHaveLength(1);
  });

  it('rejects a blank User-Agent', () => {
    expect(() => createComplianceChecker({ allowlist: { targets: [] }, userAgent: '  ' })).toThrow(
      /User-Agent/,
    );
  });
});

describe('productToken', () => {
  it.each([
    ['OpenEstateBot/1.0 (+https://x.example/bot)', 'OpenEstateBot'],
    ['OpenEstateBot (+https://x.example/bot)', 'OpenEstateBot'],
    ['  Bot ', 'Bot'],
  ])('%s → %s', (ua, token) => {
    expect(productToken(ua)).toBe(token);
  });
});
