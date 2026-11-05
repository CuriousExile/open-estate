// Framework-free keyboard model of the shared dropdown `oe-select` (WAI-ARIA APG "collapsible
// dropdown listbox": a button with `aria-haspopup="listbox"` opens a listbox that takes focus and
// marks the highlighted option with `aria-activedescendant`). Kept free of Angular and DOM types so
// it can be unit-tested with plain Jest.

export interface SelectState {
  open: boolean;
  /** Highlighted option while open (`aria-activedescendant`), `-1` = none. */
  active: number;
}

export const CLOSED_SELECT: SelectState = { open: false, active: -1 };

export type SelectAction =
  /** Key not handled: let the browser do its default (e.g. Tab moves focus). */
  | { type: 'none' }
  /** Key handled (call `preventDefault`); only the state changed. */
  | { type: 'move' }
  /** The list opened; move focus into it. */
  | { type: 'open' }
  /** Choose option `index`, close and return focus to the button. */
  | { type: 'select'; index: number }
  /** Close without a change; `restoreFocus` = move focus back to the button. */
  | { type: 'close'; restoreFocus: boolean };

export interface SelectContext {
  /** Number of options. */
  count: number;
  /** Index of the current value, `-1` if none. */
  selected: number;
}

/** Options a Page Up/Page Down jump moves. */
export const SELECT_PAGE_SIZE = 10;

/** A printable character (no modifier): starts or extends a type-ahead search. */
export function isTypeAheadKey(key: string, modifiers = false): boolean {
  return !modifiers && key.length === 1 && key !== ' ';
}

const clamp = (value: number, count: number): number => Math.min(Math.max(value, 0), count - 1);

/**
 * Next state for `key`. Closed (focus on the button): ArrowDown/Enter/Space open on the current
 * value (else the first option), ArrowUp opens on the current value (else the last), Home/End
 * open on the first/last option. Open (focus in the list): ArrowUp/ArrowDown move without wrapping,
 * Home/End/PageUp/PageDown jump, Enter/Space choose the highlighted option, Escape closes without a
 * change, Tab closes and lets the focus move on. Type-ahead is handled by {@link typeAheadMatch}.
 */
export function selectKey(
  state: SelectState,
  key: string,
  { count, selected }: SelectContext,
): { state: SelectState; action: SelectAction } {
  if (!state.open) {
    if (count === 0) return { state, action: { type: 'none' } };
    const current = selected >= 0 && selected < count ? selected : -1;
    switch (key) {
      case 'ArrowDown':
      case 'Enter':
      case ' ':
        return { state: { open: true, active: current >= 0 ? current : 0 }, action: open() };
      case 'ArrowUp':
        return {
          state: { open: true, active: current >= 0 ? current : count - 1 },
          action: open(),
        };
      case 'Home':
        return { state: { open: true, active: 0 }, action: open() };
      case 'End':
        return { state: { open: true, active: count - 1 }, action: open() };
      default:
        return { state, action: { type: 'none' } };
    }
  }
  if (count === 0) {
    return {
      state: CLOSED_SELECT,
      action: key === 'Escape' ? { type: 'close', restoreFocus: true } : { type: 'none' },
    };
  }
  const active = state.active;
  const move = (index: number) => ({
    state: { open: true, active: clamp(index, count) },
    action: { type: 'move' } as const,
  });
  switch (key) {
    case 'ArrowDown':
      return move(active < 0 ? 0 : active + 1);
    case 'ArrowUp':
      return move(active < 0 ? count - 1 : active - 1);
    case 'Home':
      return move(0);
    case 'End':
      return move(count - 1);
    case 'PageDown':
      return move(active + SELECT_PAGE_SIZE);
    case 'PageUp':
      return move(active - SELECT_PAGE_SIZE);
    case 'Enter':
    case ' ':
      return active >= 0 && active < count
        ? { state: CLOSED_SELECT, action: { type: 'select', index: active } }
        : { state: CLOSED_SELECT, action: { type: 'close', restoreFocus: true } };
    case 'Escape':
      return { state: CLOSED_SELECT, action: { type: 'close', restoreFocus: true } };
    case 'Tab':
      return { state: CLOSED_SELECT, action: { type: 'close', restoreFocus: false } };
    default:
      return { state, action: { type: 'none' } };
  }
}

function open(): SelectAction {
  return { type: 'open' };
}

/** Case- and diacritic-insensitive form for type-ahead ("Ö" → "o"). */
export function foldLabel(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('und').trimStart();
}

/**
 * Option a type-ahead `query` selects, or `-1`. Searches from `from` (inclusive) and wraps. A
 * query of one repeated character ("aaa") cycles through the options starting with it, beginning
 * after `from` — so pressing the same key repeatedly steps through them.
 */
export function typeAheadMatch(labels: readonly string[], query: string, from: number): number {
  const needle = foldLabel(query);
  if (needle === '' || labels.length === 0) return -1;
  const repeated = [...needle].every((char) => char === needle[0]);
  const prefix = repeated ? (needle[0] as string) : needle;
  const start = repeated ? from + 1 : from;
  const folded = labels.map(foldLabel);
  for (let offset = 0; offset < labels.length; offset++) {
    const index = (((start + offset) % labels.length) + labels.length) % labels.length;
    if (folded[index]?.startsWith(prefix)) return index;
  }
  return -1;
}

/** Pause after which a new keystroke starts a new type-ahead query. */
export const TYPE_AHEAD_RESET_MS = 500;

/** Accumulates type-ahead keystrokes; `now` is passed in so tests need no timers. */
export class TypeAheadBuffer {
  private text = '';
  private last = Number.NEGATIVE_INFINITY;

  /** Appends `char` (or starts over after {@link TYPE_AHEAD_RESET_MS}) and returns the query. */
  push(char: string, now: number): string {
    this.text = now - this.last > TYPE_AHEAD_RESET_MS ? char : this.text + char;
    this.last = now;
    return this.text;
  }

  reset(): void {
    this.text = '';
    this.last = Number.NEGATIVE_INFINITY;
  }
}
