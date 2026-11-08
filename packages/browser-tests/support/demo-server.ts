import type { APIRequestContext } from '@playwright/test';
import { DEV_SERVER_URL } from './env';

/** Test hook of the dev server (`DEV_TEST_HOOKS=1`, see packages/devserver/src/test-hooks.ts). */
const RESET_URL = `${DEV_SERVER_URL}/__test__/reset`;

/**
 * Replaces all demo state with a fresh seed, as after a restart. Signed-in sessions end with it
 * (the local OIDC provider gets a new key), so sign in after a reset.
 */
export async function resetDemo(request: APIRequestContext): Promise<void> {
  const response = await request.post(RESET_URL);
  if (response.status() === 404) {
    throw new Error(
      `The demo at ${DEV_SERVER_URL} has no test hooks. Playwright starts it with ` +
        'DEV_TEST_HOOKS=1; a demo you started yourself (BROWSER_TEST_REUSE_SERVER=1) needs it too.',
    );
  }
  if (!response.ok())
    throw new Error(`Reset failed: ${response.status()} ${await response.text()}`);
}
