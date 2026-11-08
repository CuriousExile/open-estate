import type { TestInfo } from '@playwright/test';

/**
 * A short value unique per test run and test (and retry), for data a test creates itself: tests
 * run in parallel against one demo, so names must not collide, and the demo keeps earlier data
 * when a reused server is not reset.
 */
export function unique(testInfo: TestInfo, prefix = 'e2e'): string {
  const random = Math.random().toString(36).slice(2, 6);
  return `${prefix}-${Date.now().toString(36)}-${testInfo.workerIndex}${testInfo.retry}-${random}`;
}
