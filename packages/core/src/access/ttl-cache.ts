/** Current time in epoch milliseconds; injectable for tests (simulated clock). */
export type Clock = () => number;

export const systemClock: Clock = () => Date.now();

/** Config changes must take effect within 60 s without a restart (Req 17.9). */
export const ACCESS_CACHE_TTL_MS = 60_000;

/**
 * Minimal in-memory cache with a fixed time-to-live per entry. An entry loaded at `t` is
 * served until `t + ttlMs` (exclusive) and reloaded afterwards. Failed loads are not cached.
 * `maxEntries` bounds memory (e.g. against floods of random API keys); the oldest entry is
 * evicted first.
 */
export class TtlCache<K, V> {
  private readonly entries = new Map<K, { value: V; loadedAt: number }>();

  constructor(
    private readonly clock: Clock,
    private readonly ttlMs: number = ACCESS_CACHE_TTL_MS,
    private readonly maxEntries: number = 10_000,
  ) {}

  async get(key: K, load: () => Promise<V>): Promise<V> {
    const now = this.clock();
    const entry = this.entries.get(key);
    if (entry !== undefined && now - entry.loadedAt < this.ttlMs) return entry.value;

    const value = await load();
    this.entries.delete(key); // re-insert so Map order reflects load time
    this.entries.set(key, { value, loadedAt: now });
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done !== true) this.entries.delete(oldest.value);
    }
    return value;
  }
}
