import { applyDiff, diffState, type DiffEntry, type VersionedState } from '../src';

// Unit tests for the diff of versioned states (design: "Diff", Req 5.5, 7.6, 7.7, 8.6).

/** Minimal state; the diff is structural, so a content subset suffices. */
const state = (
  content: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): VersionedState => ({ content, status: 'ACTIVE', ...extra }) as unknown as VersionedState;

const base = state(
  {
    title: 'Altbau',
    address: { city: 'Berlin', postalCode: '10115' },
    offers: [{ type: 'RENT', amount: 120000 }],
    media: [{ url: 'a.jpg' }, { url: 'b.jpg' }],
  },
  { customId: 'C-1' },
);

describe('diffState', () => {
  it('returns no entries for equal states', () => {
    expect(diffState(base, structuredClone(base))).toEqual([]);
  });

  it('reports add, remove and change with old and new values on nested paths', () => {
    const b = state(
      {
        title: 'Neubau',
        address: { city: 'Berlin', street: 'Hauptstr. 1' },
        offers: [{ type: 'RENT', amount: 130000 }],
        media: [{ url: 'a.jpg' }, { url: 'b.jpg' }],
      },
      { status: 'INACTIVE', agencyId: 'ag-1' },
    );
    expect(diffState(base, b)).toEqual<DiffEntry[]>([
      { op: 'add', path: ['agencyId'], value: 'ag-1' },
      { op: 'remove', path: ['content', 'address', 'postalCode'], oldValue: '10115' },
      { op: 'add', path: ['content', 'address', 'street'], value: 'Hauptstr. 1' },
      { op: 'change', path: ['content', 'offers', 0, 'amount'], oldValue: 120000, value: 130000 },
      { op: 'change', path: ['content', 'title'], oldValue: 'Altbau', value: 'Neubau' },
      { op: 'remove', path: ['customId'], oldValue: 'C-1' },
      { op: 'change', path: ['status'], oldValue: 'ACTIVE', value: 'INACTIVE' },
    ]);
  });

  it('compares arrays by position, removing surplus elements from the end', () => {
    const shorter = state(
      { ...base.content, media: [{ url: 'x.jpg' }] } as Record<string, unknown>,
      {
        customId: 'C-1',
      },
    );
    expect(diffState(base, shorter)).toEqual<DiffEntry[]>([
      { op: 'change', path: ['content', 'media', 0, 'url'], oldValue: 'a.jpg', value: 'x.jpg' },
      { op: 'remove', path: ['content', 'media', 1], oldValue: { url: 'b.jpg' } },
    ]);
    const longer = state(
      { ...base.content, media: [{ url: 'a.jpg' }, { url: 'b.jpg' }, { url: 'c.jpg' }] } as Record<
        string,
        unknown
      >,
      { customId: 'C-1' },
    );
    expect(diffState(base, longer)).toEqual<DiffEntry[]>([
      { op: 'add', path: ['content', 'media', 2], value: { url: 'c.jpg' } },
    ]);
  });

  it('reports a type change (object vs. scalar vs. array) as one change', () => {
    const b = state({ ...base.content, address: 'Berlin' } as Record<string, unknown>, {
      customId: 'C-1',
    });
    expect(diffState(base, b)).toEqual<DiffEntry[]>([
      {
        op: 'change',
        path: ['content', 'address'],
        oldValue: base.content.address,
        value: 'Berlin',
      },
    ]);
  });

  it('treats undefined values as absent and is independent of key order', () => {
    const reordered = state(
      {
        media: base.content.media,
        offers: base.content.offers,
        address: base.content.address,
        title: 'Altbau',
      },
      { customId: 'C-1', agencyId: undefined },
    );
    expect(diffState(base, reordered)).toEqual([]);
  });
});

describe('applyDiff', () => {
  it('reconstructs the target state without mutating the input', () => {
    const before = structuredClone(base);
    const targets = [
      state({ title: 'Neu', media: [] }, { status: 'INACTIVE', agencyId: 'ag-1' }),
      state({ ...base.content, media: [{ url: 'z.jpg' }] } as Record<string, unknown>),
      state(
        {
          ...base.content,
          offers: [...(base.content.offers as unknown[]), { type: 'SALE', amount: 1 }],
        } as Record<string, unknown>,
        { customId: 'C-2' },
      ),
    ];
    for (const b of targets) {
      const d = diffState(base, b);
      expect(applyDiff(base, d)).toEqual(JSON.parse(JSON.stringify(b)));
    }
    expect(base).toEqual(before);
  });

  it('does not alias values of the diff entries', () => {
    const b = state({
      ...base.content,
      media: [{ url: 'a.jpg' }, { url: 'b.jpg' }, { url: 'c.jpg' }],
    } as Record<string, unknown>);
    const d = diffState(base, b);
    const result = applyDiff(base, d);
    const [, , added] = result.content.media as unknown as { url: string }[];
    expect(added).toBeDefined();
    if (added) added.url = 'mutated';
    expect(d).toContainEqual({ op: 'add', path: ['content', 'media', 2], value: { url: 'c.jpg' } });
  });

  it('rejects entries whose path does not lead to a container', () => {
    expect(() =>
      applyDiff(base, [{ op: 'add', path: ['content', 'title', 'x'], value: 1 }]),
    ).toThrow();
    expect(() => applyDiff(base, [{ op: 'add', path: [], value: 1 }])).toThrow();
  });
});
