import {
  currentToken,
  EMPTY_FILTERS,
  FIRST_PAGE,
  formatTimestamp,
  nextPage,
  previousPage,
  validateFilters,
} from '../src/app/portal/listings/listing-table-model';
import { toDiffRows, formatDiffValue } from '../src/app/portal/shared/diff-view/diff-view-model';

describe('validateFilters', () => {
  it('sends only the filters that are set, trimmed', () => {
    expect(
      validateFilters({ ...EMPTY_FILTERS, q: ' Loft ', status: 'ACTIVE', customId: 'CRM-7' }),
    ).toEqual({ ok: true, query: { q: 'Loft', status: 'ACTIVE', customId: 'CRM-7' } });
    expect(validateFilters(EMPTY_FILTERS)).toEqual({ ok: true, query: {} });
  });

  it('rejects filters the Management_API rejects, one error per field', () => {
    const result = validateFilters({
      ...EMPTY_FILTERS,
      customId: 'x'.repeat(129),
      status: 'DELETED',
    });
    expect(result).toEqual({
      ok: false,
      errors: [
        { field: 'status', messageKey: 'portal.listings.error.invalid' },
        {
          field: 'customId',
          messageKey: 'portal.listings.error.text',
          params: { min: 1, max: 128 },
        },
      ],
    });
  });
});

describe('pager', () => {
  it('remembers the tokens of earlier pages', () => {
    const second = nextPage(FIRST_PAGE, 't2');
    const third = nextPage(second, 't3');
    expect(currentToken(third)).toBe('t3');
    expect(currentToken(previousPage(third))).toBe('t2');
    expect(currentToken(previousPage(previousPage(third)))).toBeUndefined();
    expect(previousPage(FIRST_PAGE)).toBe(FIRST_PAGE);
    // Going forward again from page 2 replaces the later tokens.
    expect(nextPage(previousPage(third), 't3b').tokens).toEqual([undefined, 't2', 't3b']);
  });
});

describe('formatTimestamp', () => {
  it('formats in the given locale and keeps unparseable values', () => {
    expect(formatTimestamp('2026-11-01T10:00:00Z', 'de')).toMatch(/2026/);
    expect(formatTimestamp('not a date', 'de')).toBe('not a date');
  });
});

describe('toDiffRows', () => {
  it('drops the content prefix, numbers list entries from 1 and formats values', () => {
    const rows = toDiffRows([
      { op: 'change', path: ['content', 'offers', 0, 'price'], oldValue: '1.00', value: '2.00' },
      { op: 'add', path: ['customId'], value: 'CRM-7' },
      { op: 'remove', path: ['content', 'media', 1], oldValue: { url: 'https://x.example/1' } },
      { op: 'add', path: ['content', 'extra'], value: 3 },
    ]);
    expect(rows.map((r) => [r.segments, r.oldValue, r.newValue])).toEqual([
      [
        [
          { kind: 'field', name: 'offers', known: true },
          { kind: 'item', position: 1 },
          { kind: 'field', name: 'price', known: true },
        ],
        '1.00',
        '2.00',
      ],
      [[{ kind: 'field', name: 'customId', known: true }], undefined, 'CRM-7'],
      [
        [
          { kind: 'field', name: 'media', known: true },
          { kind: 'item', position: 2 },
        ],
        '{"url":"https://x.example/1"}',
        undefined,
      ],
      [[{ kind: 'field', name: 'extra', known: false }], undefined, '3'],
    ]);
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
  });

  it('shows an absent value as empty text', () => {
    expect(formatDiffValue(undefined)).toBe('');
    expect(formatDiffValue(false)).toBe('false');
  });
});
