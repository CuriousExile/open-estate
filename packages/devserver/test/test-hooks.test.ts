import { createServer, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { RESET_PATH, testHooksEnabled, withTestHooks } from '../src/test-hooks';

// DEV ONLY test hooks of the local demo server (`DEV_TEST_HOOKS=1`, used by the browser tests).

describe('testHooksEnabled', () => {
  it('is off unless DEV_TEST_HOOKS is exactly 1', () => {
    expect(testHooksEnabled({})).toBe(false);
    expect(testHooksEnabled({ DEV_TEST_HOOKS: '0' })).toBe(false);
    expect(testHooksEnabled({ DEV_TEST_HOOKS: 'true' })).toBe(false);
    expect(testHooksEnabled({ DEV_TEST_HOOKS: ' 1 ' })).toBe(true);
  });
});

describe('withTestHooks', () => {
  let server: Server;
  let base: string;
  let generation: number;
  let resets: number;
  let releaseReset: (() => void) | undefined;

  const platformListener =
    (n: number): RequestListener =>
    (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(`platform ${n}`);
    };
  let current: RequestListener;

  beforeEach(async () => {
    generation = 1;
    resets = 0;
    releaseReset = undefined;
    current = platformListener(1);
    server = createServer(
      withTestHooks({
        current: () => current,
        reset: async () => {
          resets++;
          if (releaseReset === undefined) {
            await new Promise<void>((resolve) => (releaseReset = resolve));
          }
          generation++;
          current = platformListener(generation);
        },
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const text = async (path: string, init?: RequestInit) =>
    (await fetch(`${base}${path}`, init)).text();

  it('passes every other request to the current platform', async () => {
    expect(await text('/api/listings')).toBe('platform 1');
    expect(resets).toBe(0);
  });

  it('POST resets: later requests reach the new platform', async () => {
    const reset = fetch(`${base}${RESET_PATH}`, { method: 'POST' });
    // While seeding, the old platform still answers.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await text('/api/listings')).toBe('platform 1');
    releaseReset?.();
    const response = await reset;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'reset' });
    expect(await text('/api/listings')).toBe('platform 2');
  });

  it('runs concurrent resets one after the other', async () => {
    releaseReset = () => undefined; // do not block
    const responses = await Promise.all([
      fetch(`${base}${RESET_PATH}`, { method: 'POST' }),
      fetch(`${base}${RESET_PATH}`, { method: 'POST' }),
    ]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    expect(resets).toBe(2);
    expect(await text('/')).toBe('platform 3');
  });

  it('refuses other methods', async () => {
    const response = await fetch(`${base}${RESET_PATH}`);
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
    expect(resets).toBe(0);
  });
});
