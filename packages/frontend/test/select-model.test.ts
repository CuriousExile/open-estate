import {
  CLOSED_SELECT,
  foldLabel,
  isTypeAheadKey,
  SELECT_PAGE_SIZE,
  selectKey,
  TYPE_AHEAD_RESET_MS,
  TypeAheadBuffer,
  typeAheadMatch,
} from '../src/app/ui/select/select-model';

const ctx = (count: number, selected = -1) => ({ count, selected });

describe('selectKey (closed, focus on the button)', () => {
  it.each(['ArrowDown', 'Enter', ' '])('%p opens on the current value, else the first', (key) => {
    expect(selectKey(CLOSED_SELECT, key, ctx(5, 2))).toEqual({
      state: { open: true, active: 2 },
      action: { type: 'open' },
    });
    expect(selectKey(CLOSED_SELECT, key, ctx(5)).state).toEqual({ open: true, active: 0 });
  });

  it('ArrowUp opens on the current value, else the last option', () => {
    expect(selectKey(CLOSED_SELECT, 'ArrowUp', ctx(5, 1)).state.active).toBe(1);
    expect(selectKey(CLOSED_SELECT, 'ArrowUp', ctx(5)).state.active).toBe(4);
  });

  it('Home/End open on the first/last option', () => {
    expect(selectKey(CLOSED_SELECT, 'Home', ctx(5, 3)).state).toEqual({ open: true, active: 0 });
    expect(selectKey(CLOSED_SELECT, 'End', ctx(5, 3)).state).toEqual({ open: true, active: 4 });
  });

  it('ignores other keys and an empty list', () => {
    expect(selectKey(CLOSED_SELECT, 'Tab', ctx(5)).action).toEqual({ type: 'none' });
    expect(selectKey(CLOSED_SELECT, 'Escape', ctx(5)).action).toEqual({ type: 'none' });
    expect(selectKey(CLOSED_SELECT, 'ArrowDown', ctx(0)).action).toEqual({ type: 'none' });
  });
});

describe('selectKey (open, focus in the list)', () => {
  const open = (active: number) => ({ open: true, active });

  it('moves with the arrows without wrapping', () => {
    expect(selectKey(open(1), 'ArrowDown', ctx(3)).state.active).toBe(2);
    expect(selectKey(open(2), 'ArrowDown', ctx(3)).state.active).toBe(2);
    expect(selectKey(open(1), 'ArrowUp', ctx(3)).state.active).toBe(0);
    expect(selectKey(open(0), 'ArrowUp', ctx(3)).state.active).toBe(0);
    expect(selectKey(open(1), 'ArrowUp', ctx(3)).action).toEqual({ type: 'move' });
  });

  it('jumps with Home/End and PageUp/PageDown (clamped)', () => {
    expect(selectKey(open(5), 'Home', ctx(30)).state.active).toBe(0);
    expect(selectKey(open(5), 'End', ctx(30)).state.active).toBe(29);
    expect(selectKey(open(5), 'PageDown', ctx(30)).state.active).toBe(5 + SELECT_PAGE_SIZE);
    expect(selectKey(open(25), 'PageDown', ctx(30)).state.active).toBe(29);
    expect(selectKey(open(5), 'PageUp', ctx(30)).state.active).toBe(0);
  });

  it.each(['Enter', ' '])('%p chooses the highlighted option and closes', (key) => {
    expect(selectKey(open(2), key, ctx(3))).toEqual({
      state: CLOSED_SELECT,
      action: { type: 'select', index: 2 },
    });
  });

  it('Escape closes without a change and returns focus; Tab lets focus move on', () => {
    expect(selectKey(open(2), 'Escape', ctx(3))).toEqual({
      state: CLOSED_SELECT,
      action: { type: 'close', restoreFocus: true },
    });
    expect(selectKey(open(2), 'Tab', ctx(3))).toEqual({
      state: CLOSED_SELECT,
      action: { type: 'close', restoreFocus: false },
    });
  });

  it('closes on Enter without a highlighted option', () => {
    expect(selectKey(open(-1), 'Enter', ctx(3)).action).toEqual({
      type: 'close',
      restoreFocus: true,
    });
  });
});

describe('type-ahead', () => {
  const labels = ['Deutsch', 'English', 'Español', 'Français', 'Ελληνικά'];

  it('accepts printable keys without modifiers only (Space selects)', () => {
    expect(isTypeAheadKey('a')).toBe(true);
    expect(isTypeAheadKey('ä')).toBe(true);
    expect(isTypeAheadKey(' ')).toBe(false);
    expect(isTypeAheadKey('ArrowDown')).toBe(false);
    expect(isTypeAheadKey('a', true)).toBe(false);
  });

  it('matches a prefix case- and diacritic-insensitively, from the current option', () => {
    expect(typeAheadMatch(labels, 'fr', 0)).toBe(3);
    expect(typeAheadMatch(labels, 'ESP', 0)).toBe(2);
    expect(typeAheadMatch(['Österreich', 'Oman'], 'o', -1)).toBe(0);
    expect(typeAheadMatch(labels, 'en', 1)).toBe(1);
    expect(typeAheadMatch(labels, 'x', 0)).toBe(-1);
    expect(typeAheadMatch([], 'a', 0)).toBe(-1);
  });

  it('cycles through options with the same first letter when the key repeats', () => {
    expect(typeAheadMatch(labels, 'e', 0)).toBe(1);
    expect(typeAheadMatch(labels, 'ee', 1)).toBe(2);
    expect(typeAheadMatch(labels, 'eee', 2)).toBe(1); // wraps (Ελληνικά starts with ε)
  });

  it('folds labels for matching', () => {
    expect(foldLabel(' Éire')).toBe('eire');
  });

  it('buffers keystrokes until a pause', () => {
    const buffer = new TypeAheadBuffer();
    expect(buffer.push('f', 1000)).toBe('f');
    expect(buffer.push('r', 1100)).toBe('fr');
    expect(buffer.push('e', 1100 + TYPE_AHEAD_RESET_MS + 1)).toBe('e');
    buffer.reset();
    expect(buffer.push('d', 1700)).toBe('d');
  });
});
