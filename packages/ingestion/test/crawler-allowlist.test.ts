import { crawlerAllowlistSchema, normalizeOrigin } from '@open-estate/ingestion';

const issuePaths = (input: unknown): string[] => {
  const result = crawlerAllowlistSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((i) => i.path.join('.'));
};

describe('crawlerAllowlistSchema', () => {
  it('accepts the documented example and normalizes origins', () => {
    const parsed = crawlerAllowlistSchema.parse({
      targets: [
        { origin: 'HTTPS://Partner.Example:443/', legalBasis: 'LV-2025-07', ratePerSecond: 1 },
        { origin: 'http://other.example:8080', legalBasis: 'AGB §4', notes: 'nur Exposés' },
      ],
    });
    expect(parsed.targets.map((t) => t.origin)).toEqual([
      'https://partner.example',
      'http://other.example:8080',
    ]);
  });

  it('keeps missing, null and blank legal bases for the runtime check (Req 6.9)', () => {
    const parsed = crawlerAllowlistSchema.parse({
      targets: [
        { origin: 'https://a.example' },
        { origin: 'https://b.example', legalBasis: null },
        { origin: 'https://c.example', legalBasis: '  ' },
      ],
    });
    expect(parsed.targets.map((t) => t.legalBasis)).toEqual([undefined, null, '  ']);
  });

  it.each([
    'ftp://a.example',
    'https://a.example/path',
    'https://a.example?q=1',
    'https://a.example#x',
    'https://user:pw@a.example',
    'a.example',
  ])('rejects origin %s', (origin) => {
    expect(issuePaths({ targets: [{ origin, legalBasis: 'x' }] })).toEqual(['targets.0.origin']);
  });

  it.each([0.09, 100.1])('rejects ratePerSecond %d', (ratePerSecond) => {
    expect(
      issuePaths({ targets: [{ origin: 'https://a.example', legalBasis: 'x', ratePerSecond }] }),
    ).toEqual(['targets.0.ratePerSecond']);
  });

  it('rejects duplicate origins after normalization and unknown keys', () => {
    expect(
      issuePaths({
        targets: [
          { origin: 'https://a.example', legalBasis: 'x' },
          { origin: 'https://A.example:443', legalBasis: 'y' },
        ],
      }),
    ).toEqual(['targets.1.origin']);
    expect(issuePaths({ targets: [{ origin: 'https://a.example', extra: 1 }] })).toEqual([
      'targets.0',
    ]);
  });
});

describe('normalizeOrigin', () => {
  it('returns undefined for non-http(s) or invalid input', () => {
    expect(normalizeOrigin('mailto:a@b.example')).toBeUndefined();
    expect(normalizeOrigin('nope')).toBeUndefined();
    expect(normalizeOrigin('https://Bücher.example/x')).toBe('https://xn--bcher-kva.example');
  });
});
