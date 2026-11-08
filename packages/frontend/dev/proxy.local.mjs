// DEV ONLY: `ng serve --configuration local` proxy to the local demo server (packages/devserver,
// docs/local-demo.md). Reads the dev server's address from the same variables as the server:
// DEV_HOST (default 127.0.0.1) and DEV_PORT (default 4310). `npm run dev` validates them before
// `ng serve` starts. `runtime-config.json` comes from the dev server too, so the SPA gets the
// issuer of the running server instead of a hard-coded port.
const host = process.env.DEV_HOST?.trim() || '127.0.0.1';
const port = process.env.DEV_PORT?.trim() || '4310';
const target = `http://${host === '::1' ? '[::1]' : host}:${port}`;

const PROXIED = ['/api', '/management', '/mcp', '/demo-media', '/runtime-config.json'];

export default Object.fromEntries(
  PROXIED.map((path) => [path, { target, secure: false, changeOrigin: false }]),
);
