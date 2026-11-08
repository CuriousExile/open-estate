import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';

// DEV ONLY — test support, off by default. With `DEV_TEST_HOOKS=1` the dev server answers
// `POST /__test__/reset`: all state is replaced by a freshly seeded platform, as after a restart,
// so the browser tests (packages/browser-tests) can give every state-changing test the seed.
// `npm run dev` never sets the variable; without it the path is an unknown route (404).

/** Path of the reset hook. */
export const RESET_PATH = '/__test__/reset';

/** `true` only for `DEV_TEST_HOOKS=1`. */
export function testHooksEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return env['DEV_TEST_HOOKS']?.trim() === '1';
}

export interface TestHookOptions {
  /** Builds and seeds a new platform and makes it current; resolves when it serves requests. */
  reset: () => Promise<void>;
  /** Listener of the current platform (read per request, so a reset takes effect at once). */
  current: () => RequestListener;
  log?: (line: string) => void;
}

function send(res: ServerResponse, status: number, headers: Record<string, string>, body = '') {
  res.writeHead(status, headers);
  res.end(body);
}

/**
 * Request listener in front of the current platform's listener that adds the reset hook. Resets
 * run one at a time; requests arriving during a reset are still answered by the old platform.
 */
export function withTestHooks({ reset, current, log }: TestHookOptions): RequestListener {
  let queue: Promise<void> = Promise.resolve();
  return (req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path !== RESET_PATH) {
      current()(req, res);
      return;
    }
    if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
      send(res, 405, { Allow: 'POST' });
      return;
    }
    const started = Date.now();
    const run = queue.then(reset);
    queue = run.catch(() => undefined);
    run.then(
      () => {
        log?.(`test hook: state reset to the seed (${Date.now() - started} ms)`);
        send(res, 200, { 'Content-Type': 'application/json' }, '{"status":"reset"}\n');
      },
      (error: unknown) => {
        log?.(`test hook: reset failed: ${error instanceof Error ? error.message : String(error)}`);
        send(res, 500, { 'Content-Type': 'text/plain' }, 'Reset failed\n');
      },
    );
  };
}
