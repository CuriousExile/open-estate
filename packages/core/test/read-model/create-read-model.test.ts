import {
  createAccessGuard,
  createReadModel,
  InMemoryApiKeyStore,
  InMemoryRateLimitCounterStore,
  InMemorySearchProvider,
  NO_SUSPENDED_AGENCIES,
  StaticAccessConfigSource,
  type ReadModelParts,
  type UsageItem,
} from '@open-estate/core';
import { assertValidTaxonomy, DEFAULT_TAXONOMY_CONFIG } from '@open-estate/shared';
import { listing } from '../search/fixtures';

// `createReadModel`: the injection point behind `initReadModel` (tests, local dev server).

function parts(overrides: Partial<ReadModelParts> = {}): ReadModelParts {
  return {
    guard: createAccessGuard({
      config: new StaticAccessConfigSource({
        mode: 'open',
        rateLimit: { requests: 100, windowSeconds: 60 },
      }),
      apiKeys: new InMemoryApiKeyStore(),
      counters: new InMemoryRateLimitCounterStore(),
    }),
    provider: new InMemorySearchProvider([listing('a-1'), listing('b-2')]),
    taxonomy: assertValidTaxonomy(DEFAULT_TAXONOMY_CONFIG),
    locales: { defaultLocale: 'de', enabled: [{ locale: 'de', label: 'Deutsch' }] },
    defaultCurrency: 'EUR',
    tourProviders: { providers: [] },
    suspendedAgencies: NO_SUSPENDED_AGENCIES,
    ...overrides,
  };
}

describe('createReadModel', () => {
  it('builds schemas and services over the injected provider', async () => {
    const model = createReadModel(parts());
    expect(model.defaultCurrency).toBe('EUR');
    expect(model.schemas.listing).toBeDefined();
    const detail = await model.listings.get('a-1', []);
    expect(detail.ok && detail.value.id).toBe('a-1');
  });

  it('records usage of detail calls with the injected recorder', async () => {
    const recorded: { kind: string; items: readonly UsageItem[] }[] = [];
    const model = createReadModel(
      parts({ usage: { record: (kind, items) => recorded.push({ kind, items }) } }),
    );
    await model.listings.get('b-2', []);
    expect(recorded).toEqual([{ kind: 'detail', items: [{ id: 'b-2' }] }]);
  });

  it('hides listings of agencies the injected source reports as suspended', async () => {
    const provider = new InMemorySearchProvider();
    provider.put(listing('c-3'), { status: 'ACTIVE', agencyId: 'agency-x' });
    const model = createReadModel(
      parts({ provider, suspendedAgencies: { current: async () => new Set(['agency-x']) } }),
    );
    const detail = await model.listings.get('c-3', []);
    expect(detail.ok).toBe(false);
  });
});
