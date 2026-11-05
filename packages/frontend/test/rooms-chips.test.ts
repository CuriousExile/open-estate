import {
  ROOMS_CHIP_MAX,
  ROOMS_CHIPS,
  roomsChipIndex,
  roomsChipValue,
} from '../src/app/search/rooms-chips';
import {
  INITIAL_SEARCH_FORM_VALUES,
  validateSearchForm,
} from '../src/app/search/validate-search-form';

describe('rooms chips', () => {
  it('offers "Any" plus 1+ … 5+ as roomsMin values', () => {
    expect(ROOMS_CHIPS.map((chip) => chip.value)).toEqual(['', '1', '2', '3', '4', '5']);
    expect(ROOMS_CHIPS.map((chip) => chip.count)).toEqual([undefined, 1, 2, 3, 4, 5]);
    expect(ROOMS_CHIP_MAX).toBe(5);
  });

  it('maps every chip to a valid search (roomsMin only, no roomsMax)', () => {
    for (const chip of ROOMS_CHIPS) {
      const result = validateSearchForm({ ...INITIAL_SEARCH_FORM_VALUES, roomsMin: chip.value });
      expect(result).toEqual({
        params: { offerType: 'SALE', ...(chip.value !== '' && { roomsMin: chip.value }) },
      });
    }
  });

  it.each([
    ['', ''],
    ['  ', ''],
    ['3', '3'],
    ['3.0', '3'],
    ['3,0', '3'],
    [' 2 ', '2'],
  ])('maps roomsMin %p to chip %p', (input, chip) => {
    expect(roomsChipValue(input)).toBe(chip);
  });

  it.each([['2.5'], ['6'], ['0'], ['abc']])(
    'keeps %p unchanged (no chip is checked, the value still applies)',
    (input) => {
      expect(roomsChipValue(input)).toBe(input);
      expect(roomsChipIndex(input)).toBe(-1);
    },
  );

  it('finds the index of the checked chip', () => {
    expect(roomsChipIndex('')).toBe(0);
    expect(roomsChipIndex('4')).toBe(4);
  });
});
