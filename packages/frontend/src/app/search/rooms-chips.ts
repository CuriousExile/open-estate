// Framework-free model of the rooms chips of the search bar ("Any · 1+ · 2+ · 3+ · 4+ · 5+"): a
// single-choice radio group that maps to the `roomsMin` filter. Kept free of Angular so it can be
// unit-tested with plain Jest.

export interface RoomsChip {
  /** `roomsMin` value in API representation; `''` = no room filter. */
  value: string;
  /** Minimum room count shown as "n+", `undefined` for "Any". */
  count?: number;
}

/** Highest chip; "5+" covers everything above. */
export const ROOMS_CHIP_MAX = 5;

export const ROOMS_CHIPS: readonly RoomsChip[] = [
  { value: '' },
  ...Array.from({ length: ROOMS_CHIP_MAX }, (_, i) => ({ value: String(i + 1), count: i + 1 })),
];

/**
 * Chip value for a `roomsMin` form value: `''` (Any) for an empty value; a whole number from 1 to
 * {@link ROOMS_CHIP_MAX} (also written "2.0" or "2,0") becomes that chip. Any other value — e.g.
 * "2.5" from a deep link — has no chip and is kept as is, so no chip is checked and the filter
 * still applies (and is validated) unchanged.
 */
export function roomsChipValue(roomsMin: string): string {
  const text = roomsMin.trim().replace(',', '.');
  if (text === '') return '';
  if (!/^\d+(\.0+)?$/.test(text)) return roomsMin;
  const count = Number(text);
  return count >= 1 && count <= ROOMS_CHIP_MAX ? String(count) : roomsMin;
}

/** Index of the checked chip for `roomsMin`, `-1` if none matches. */
export function roomsChipIndex(roomsMin: string): number {
  const value = roomsChipValue(roomsMin);
  return ROOMS_CHIPS.findIndex((chip) => chip.value === value);
}
