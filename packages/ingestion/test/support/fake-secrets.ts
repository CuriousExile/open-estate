import type { SecretResolver } from '@open-estate/ingestion';

/** In-memory `SecretResolver`; records requested refs, throws for unknown ones. */
export function createFakeSecrets(
  values: Record<string, string>,
): SecretResolver & { requested: string[] } {
  const requested: string[] = [];
  return {
    requested,
    get: async (ref) => {
      requested.push(ref);
      const value = values[ref];
      if (value === undefined) throw new Error(`unknown secret ${ref}`);
      return value;
    },
  };
}
