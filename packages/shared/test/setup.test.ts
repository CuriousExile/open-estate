import fc from 'fast-check';

describe('test tooling', () => {
  it('applies the global fast-check defaults from jest.setup.ts', () => {
    expect(fc.readConfigureGlobal().numRuns).toBe(100);
  });
});
