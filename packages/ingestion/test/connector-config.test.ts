import {
  connectorsFileSchema,
  DEFAULT_TIMEOUT_SECONDS,
  isValidScheduleExpression,
  MAX_TIMEOUT_SECONDS,
} from '@open-estate/ingestion';

const entry = (overrides: Record<string, unknown> = {}) => ({
  id: 'partner-db',
  type: 'relational-db',
  module: 'relational-db',
  enabled: true,
  schedule: 'rate(1 hour)',
  settings: { query: 'SELECT 1' },
  ...overrides,
});

const issuePaths = (input: unknown): string[] => {
  const result = connectorsFileSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((i) => i.path.join('.'));
};

describe('connectorsFileSchema', () => {
  it('accepts a valid file and applies defaults', () => {
    const parsed = connectorsFileSchema.parse([
      entry(),
      entry({ id: 'api', type: 'external-api', module: 'external-api', secretRef: 'oe/api-key' }),
      {
        id: 'crawler',
        type: 'web-crawler',
        module: 'web-crawler',
        enabled: false,
        schedule: 'cron(0 3 * * ? *)',
      },
    ]);
    expect(parsed[0]).toMatchObject({
      timeoutSeconds: DEFAULT_TIMEOUT_SECONDS,
      settings: { query: 'SELECT 1' },
    });
    expect(parsed[0]).not.toHaveProperty('secretRef');
    expect(parsed[1]?.secretRef).toBe('oe/api-key');
    expect(parsed[2]?.settings).toEqual({});
  });

  it('accepts an empty file', () => {
    expect(connectorsFileSchema.parse([])).toEqual([]);
  });

  it('rejects duplicate ids at the duplicate entry', () => {
    expect(issuePaths([entry(), entry({ module: 'other' }), entry({ id: 'x' })])).toEqual(['1.id']);
  });

  it.each([
    ['type', { type: 'ftp' }],
    ['schedule', { schedule: 'every hour' }],
    ['timeoutSeconds', { timeoutSeconds: 0 }],
    ['timeoutSeconds', { timeoutSeconds: MAX_TIMEOUT_SECONDS + 1 }],
    ['timeoutSeconds', { timeoutSeconds: 1.5 }],
    ['id', { id: 'Not A Slug' }],
    ['module', { module: '../../evil.js' }],
    ['enabled', { enabled: 'yes' }],
    ['secretRef', { secretRef: '' }],
  ])('rejects invalid %s', (path, overrides) => {
    expect(issuePaths([entry(overrides)])).toEqual([`0.${path}`]);
  });

  it('rejects missing required fields and unknown keys', () => {
    expect(issuePaths([entry({ schedule: undefined })])).toEqual(['0.schedule']);
    expect(issuePaths([entry({ extra: 1 })])).toEqual(['0']);
  });
});

describe('isValidScheduleExpression', () => {
  it.each([
    'rate(1 minute)',
    'rate(5 minutes)',
    'rate(1 day)',
    'rate(12 hours)',
    'cron(0 3 * * ? *)',
    'cron(0/15 8-18 ? * MON-FRI *)',
    'cron(0 12 L * ? 2026)',
  ])('accepts %s', (expression) => {
    expect(isValidScheduleExpression(expression)).toBe(true);
  });

  it.each([
    '',
    'rate(0 minutes)',
    'rate(1 minutes)',
    'rate(5 minute)',
    'rate(1 week)',
    'rate(-1 hours)',
    'at(2026-01-01T00:00:00)',
    'cron(0 3 * * *)',
    'cron(0 3 * * * *)',
    'cron(0 3 ? * ? *)',
    'cron(? 3 * * ? *)',
    'cron(0  3 * * ? *)',
    '0 3 * * ? *',
  ])('rejects %s', (expression) => {
    expect(isValidScheduleExpression(expression)).toBe(false);
  });
});
