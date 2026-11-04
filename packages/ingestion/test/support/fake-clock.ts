import type { Clock } from '@open-estate/ingestion';

export interface FakeClock extends Clock {
  /** Every `sleep` duration requested so far, in call order. */
  readonly sleeps: number[];
}

/**
 * Virtual-time clock: `sleep(ms)` schedules a timer at `now + ms`. Once the
 * event loop is idle (via `setImmediate`, after pending microtasks), the
 * earliest timer fires and time jumps to its deadline. Timers therefore fire
 * in deadline order and concurrent sleepers observe consistent timestamps.
 */
export function createFakeClock(start = 0): FakeClock {
  let current = start;
  const timers: { at: number; resolve: () => void }[] = [];
  const sleeps: number[] = [];

  const fireEarliest = (): void => {
    timers.sort((a, b) => a.at - b.at);
    const timer = timers.shift();
    if (timer === undefined) return;
    current = Math.max(current, timer.at);
    timer.resolve();
  };

  return {
    sleeps,
    now: () => current,
    sleep(ms) {
      sleeps.push(ms);
      return new Promise((resolve) => {
        timers.push({ at: current + Math.max(0, ms), resolve });
        setImmediate(fireEarliest);
      });
    },
  };
}
