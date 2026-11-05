import { createServer } from 'node:http';
import { DemoClock, loadContentConfig, readNetworkConfig } from './config';
import { DEMO_MEDIA_PREFIX } from './media/demo-media';
import { createDevPlatform } from './platform';
import { demoFeedModule } from './seed/demo-connector';
import { AGENCIES, SEED_USERS } from './seed/demo-data';
import { CRM_BATCHES, CRM_CONNECTOR_ID, seedDemo } from './seed/seed';
import { PREFIX, createRequestListener } from './server';

// DEV ONLY — INSECURE. Entry of the local demo server (`npm run dev`). Runs the Search_API,
// MCP_Server and Management_API on in-memory stores with seeded demo data and a local OIDC
// provider without passwords. State lives in memory and is lost on restart. Binds to loopback
// only; never deploy or expose it.

/** Client id of the portal; equals `portal.clientId` of the SPA's local runtime config. */
export const DEV_CLIENT_ID = 'local-portal-client';

async function main(): Promise<void> {
  const network = readNetworkConfig(process.env);
  const clock = new DemoClock();
  const issuer = `${network.publicUrl}${PREFIX.oidc}`;
  const platform = createDevPlatform({
    config: loadContentConfig(),
    clock,
    frontendOrigin: network.frontendOrigin,
    issuer,
    clientId: DEV_CLIENT_ID,
    directoryUsers: SEED_USERS,
    userHints: Object.fromEntries(SEED_USERS.map((user) => [user.userId, user.hint])),
    connectorModules: [demoFeedModule(CRM_BATCHES)],
  });
  const seeded = await seedDemo(platform);
  const base = network.publicUrl;
  const info = () => ({
    warning: 'DEV ONLY — insecure local demo server with in-memory state. Never expose it.',
    frontend: network.frontendOrigin,
    searchApi: `${base}${PREFIX.api}`,
    mcp: `${base}${PREFIX.mcp}`,
    managementApi: `${base}${PREFIX.management}`,
    demoMedia: `${network.frontendOrigin}${DEMO_MEDIA_PREFIX}`,
    oidcIssuer: issuer,
    users: SEED_USERS.map(({ email, displayName, role, agencyId }) => ({
      email,
      displayName,
      role,
      ...(agencyId !== undefined && { agencyId }),
    })),
    agencies: Object.values(AGENCIES),
    connector: CRM_CONNECTOR_ID,
  });

  const quiet = process.env['DEV_QUIET'] === '1';
  const server = createServer(
    createRequestListener({
      platform,
      info,
      mediaPublicBase: `${network.frontendOrigin}${DEMO_MEDIA_PREFIX}`,
      ...(!quiet && { log: (line: string) => console.log(`[dev] ${line}`) }),
    }),
  );
  server.listen(network.port, network.host, () => {
    const listings = platform.stores.listings.all();
    const active = listings.filter((item) => item.status === 'ACTIVE').length;
    console.log(
      [
        '',
        '  OpenEstate local demo — DEV ONLY, insecure, in-memory (state is lost on restart)',
        '',
        `  Search API      ${base}${PREFIX.api}/listings`,
        `  MCP endpoint    ${base}${PREFIX.mcp}`,
        `  Management API  ${base}${PREFIX.management}/openapi.json`,
        `  OIDC issuer     ${issuer}/.well-known/openid-configuration`,
        `  Frontend        ${network.frontendOrigin}  (ng serve, see docs/local-demo.md)`,
        '',
        `  Seeded: ${listings.length} listings (${active} ACTIVE), ${seeded.runs.length} connector runs`,
        '  Demo users (pick one on the local login page, no password):',
        ...SEED_USERS.map((user) => `    - ${user.email.padEnd(36)} ${user.role}`),
        `  Machine access of ${AGENCIES.nordlicht.displayName} (CRM-Sync, demo only):`,
        `    Authorization: Bearer ${seeded.machineCredential}`,
        '',
      ].join('\n'),
    );
  });

  const stop = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2_000).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((error: unknown) => {
  console.error('[dev] failed to start:', error);
  process.exit(1);
});
