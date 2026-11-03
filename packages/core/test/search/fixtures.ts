import type { Listing } from '@open-estate/shared';
import { exampleListing } from '../../../shared/test/arbitraries';

export function listing(id: string): Listing {
  return exampleListing(id);
}

/** `count` listings with zero-padded ids, returned in shuffled (non-id) order. */
export function listings(count: number): Listing[] {
  const all = Array.from({ length: count }, (_, i) => listing(`id-${String(i).padStart(3, '0')}`));
  return all.reverse();
}

export function sortedIds(items: readonly Listing[]): string[] {
  return items.map((l) => l.id).sort();
}
