import {
  createDeletionWorkflow,
  InMemoryDeletionBlocklistStore,
  InMemoryDeletionRequestStore,
  InProcessDeletionWorkflowStarter,
} from '@open-estate/admin';
import { createListingsRoutes, type ListingsHandler } from '@open-estate/api';
import {
  InMemoryDuplicateIndexStore,
  InMemoryIdempotencyStore,
  AgencyService,
  CachingAuthenticator,
  contentRules,
  createAccessGuard,
  createAdminOperations,
  createCachedSuspendedAgencies,
  createMetricDefinitions,
  createReadModel,
  DuplicateDetector,
  duplicateDataPurge,
  DuplicateReportService,
  DuplicateSweep,
  formatUsageLine,
  handleUsageBatch,
  InMemoryAdminAuditLog,
  InMemoryAgencyStore,
  InMemoryApiKeyStore,
  InMemoryAuditService,
  InMemoryConnectorRunStore,
  InMemoryDuplicateReportStore,
  InProcessDuplicateSweepStarter,
  InMemoryIdentityDirectory,
  InMemoryListingHistoryStore,
  InMemoryListingKeyStore,
  InMemoryListingVersionStore,
  InMemoryMachineAccessStore,
  InMemoryManagedListingStore,
  InMemoryMembershipStore,
  InMemoryMetricCounterStore,
  InMemoryPlatformCounterStore,
  InMemoryRateLimitCounterStore,
  InMemorySnapshotStore,
  InMemoryTransactor,
  ListingCommandService,
  ListingQueryService,
  MachineAccessService,
  manualContentSchema,
  MembershipService,
  MetricCatalog,
  MonitoringQueries,
  MonitoringService,
  runDuplicateSweep,
  StaticAccessConfigSource,
  StaticDuplicateDetectionSetting,
  VersionedListingWriter,
  VersionService,
  type AdminOperations,
  type DirectoryUser,
  type ReadModel,
  type ReloadOutcome,
  type UsageRecorder,
} from '@open-estate/core';
import {
  ConnectorFramework,
  ConnectorRegistry,
  ImportPipeline,
  InMemoryDeletionBlocklist,
  type ConnectorModule,
} from '@open-estate/ingestion';
import {
  AgencyOverview,
  createIdentityRouteList,
  createListingRoutes,
  createDuplicateRoutes,
  createManagementAccessGuard,
  createManagementHandler,
  createMonitoringRoutes,
  createOpenApiRoute,
  createPlatformRoutes,
  createRouter,
  machineAccessAudit,
  StaticRateLimitSource,
  type ManagementHandler,
} from '@open-estate/management';
import { createMcpHandler, type McpHandler } from '@open-estate/mcp';
import { buildSchemas } from '@open-estate/shared';
import type { ContentConfig, DemoClock } from './config';
import { ManagedDeletionListingStore } from './deletion-store';
import { createFakeCloudWatch, FAKE_ALARM_PREFIX } from './fake-cloudwatch';
import { DevOidcProvider, type DemoUser } from './oidc/provider';
import { ManagedListingProjection } from './projection';

// DEV ONLY: the whole platform in one process on the in-memory fakes of `core`, `admin` and
// `ingestion`. Search_API, MCP_Server and Management_API run their real routers and use cases on
// ONE shared state; only the AWS edges are replaced (DynamoDB/S3 → in-memory stores, Cognito →
// local OIDC provider, Step Functions → in-process deletion workflow, CloudWatch → synthetic
// series, DynamoDB Streams → read-time projection). Nothing here is used by a Lambda bundle.

/** Generous limits: the SPA and a demo audience share the loopback IP. */
const DEV_RATE_LIMIT = { requests: 10_000, windowSeconds: 60 } as const;
/** Short caches, so suspensions and role changes show up within seconds in the demo. */
const DEV_CACHE_TTL_MS = 5_000;

export interface DevPlatformOptions {
  config: ContentConfig;
  clock: DemoClock;
  /** SPA origin (public detail URLs). */
  frontendOrigin: string;
  /** Issuer URL of the local OIDC provider. */
  issuer: string;
  /** Client id of the portal (as in the SPA's `runtime-config.json`). */
  clientId: string;
  /** Seeded identities (Cognito users of a deployment). */
  directoryUsers?: readonly DirectoryUser[];
  /** Explanations shown on the login page, by user id. */
  userHints?: Readonly<Record<string, string>>;
  /** Connector modules available to {@link DevPlatform.runConnector}. */
  connectorModules?: readonly ConnectorModule[];
  /**
   * Ein/Aus of the Duplikat-Erkennung at start (`DEV_DUPLICATE_DETECTION`); default on. The
   * Plattform_Admin switches it in the admin mode like in AWS.
   */
  duplicateDetection?: boolean;
  logger?: { error(message: string, attributes: Record<string, unknown>): void };
}

/** Handlers plus the shared stores and use cases (seeding and tests use them directly). */
export type DevPlatform = ReturnType<typeof createDevPlatform>;

export function createDevPlatform(options: DevPlatformOptions) {
  const { config, frontendOrigin } = options;
  const clock = options.clock.now;

  // ---- shared state ------------------------------------------------------------------------
  const audit = new InMemoryAuditService({ now: clock });
  const transactor = new InMemoryTransactor();
  const agencies = new InMemoryAgencyStore();
  const memberships = new InMemoryMembershipStore();
  const platformCounters = new InMemoryPlatformCounterStore();
  const machineAccessStore = new InMemoryMachineAccessStore();
  const counters = new InMemoryMetricCounterStore();
  const listings = new InMemoryManagedListingStore();
  const versions = new InMemoryListingVersionStore();
  const keys = new InMemoryListingKeyStore();
  const snapshots = new InMemorySnapshotStore();
  // One blocklist for the writer's transaction check, the import pre-check and the deletion
  // workflow (mirror of the admin blocklist store).
  const blocklist = new InMemoryDeletionBlocklist();
  const connectorRuns = new InMemoryConnectorRunStore();
  const directory = new InMemoryIdentityDirectory(options.directoryUsers ?? []);
  const apiKeys = new InMemoryApiKeyStore();
  const accessConfig = new StaticAccessConfigSource({ mode: 'open', rateLimit: DEV_RATE_LIMIT });

  // Duplikat-Erkennung (duplicate-detection): index and Idempotenzschlüssel in memory; the
  // switch of the admin mode is held here instead of in SSM.
  const duplicateDetection = new StaticDuplicateDetectionSetting(
    options.duplicateDetection ?? true,
  );
  const duplicateIndex = new InMemoryDuplicateIndexStore();
  const idempotency = new InMemoryIdempotencyStore();
  const duplicateReports = new InMemoryDuplicateReportStore();
  const detector = new DuplicateDetector({
    index: duplicateIndex,
    taxonomy: config.taxonomy,
    config: config.duplicateDetection,
  });
  const writer = new VersionedListingWriter({
    listings,
    versions,
    keys,
    blocklist,
    counters,
    snapshots,
    transactor,
    clock,
    duplicates: { index: duplicateIndex, detector, frontendOrigin },
    idempotency,
  });

  // ---- Search_API and MCP_Server -----------------------------------------------------------
  // Usage lines go straight into the counters (in AWS: log subscription → UsageAggregator).
  const usage: UsageRecorder = {
    record(kind, items) {
      if (items.length === 0) return;
      const events = [{ timestamp: clock(), message: formatUsageLine(kind, items) }];
      handleUsageBatch(events, { counters }).catch(() => undefined);
    },
  };
  const readModel: ReadModel = createReadModel({
    guard: createAccessGuard({
      config: accessConfig,
      apiKeys,
      counters: new InMemoryRateLimitCounterStore(),
      clock,
      cacheTtlMs: DEV_CACHE_TTL_MS,
    }),
    provider: new ManagedListingProjection(listings),
    taxonomy: config.taxonomy,
    locales: config.locales,
    defaultCurrency: config.defaultCurrency,
    tourProviders: config.tourProviders,
    exchangeRates: config.exchangeRates,
    suspendedAgencies: createCachedSuspendedAgencies({
      store: agencies,
      clock,
      ttlMs: DEV_CACHE_TTL_MS,
    }),
    usage,
  });
  const search: ListingsHandler = createListingsRoutes(readModel);
  const mcp: McpHandler = createMcpHandler(readModel);

  // ---- identity ----------------------------------------------------------------------------
  const agencyService = new AgencyService({ agencies, memberships, counters, audit, clock });
  const membershipService = new MembershipService({
    memberships,
    agencies,
    platformCounters,
    identity: directory,
    transactor,
    audit,
    clock,
  });
  const machineAccessService = new MachineAccessService({
    store: machineAccessStore,
    agencies,
    audit: machineAccessAudit(audit),
    clock,
  });

  // ---- listings ----------------------------------------------------------------------------
  const commands = new ListingCommandService({
    listings,
    versions,
    snapshots,
    agencies,
    writer,
    audit,
    frontendOrigin,
    contentSchema: manualContentSchema(config.taxonomy),
    rules: contentRules({
      tourProviders: config.tourProviders,
      piiAllowlist: config.piiAllowlist,
      taxonomy: config.taxonomy,
    }),
    duplicates: detector,
    detection: duplicateDetection,
    idempotency,
    clock,
  });
  const queries = new ListingQueryService({ listings, keys, audit, frontendOrigin });
  const versionService = new VersionService({ listings, versions, snapshots, audit });

  // ---- monitoring --------------------------------------------------------------------------
  const cloudWatch = createFakeCloudWatch(clock);
  const catalog = new MetricCatalog(
    createMetricDefinitions({
      counters,
      agencies,
      listings,
      connectorRuns,
      cloudWatch,
      metricsNamespace: 'OpenEstate',
    }),
  );
  const monitoring = new MonitoringService({ catalog, audit });
  const monitoringQueries = new MonitoringQueries({
    monitoring,
    connectorRuns,
    agencies,
    listings,
    cloudWatch,
    alarmNamePrefix: FAKE_ALARM_PREFIX,
    audit,
    clock: () => new Date(clock()),
  });

  // ---- platform operations (Admin_API use cases) -------------------------------------------
  const adminAudit = new InMemoryAdminAuditLog();
  const deletionRequests = new InMemoryDeletionRequestStore();
  const deletionListings = new ManagedDeletionListingStore({
    listings,
    requests: deletionRequests,
    keys,
    counters,
  });
  const deletionBlocklist = new InMemoryDeletionBlocklistStore(blocklist);
  const deletionWorkflow = createDeletionWorkflow({
    requests: deletionRequests,
    listings: deletionListings,
    blocklist: deletionBlocklist,
    history: new InMemoryListingHistoryStore({ versions, snapshots }),
    audit: adminAudit,
    clock,
    duplicates: duplicateDataPurge({
      index: duplicateIndex,
      idempotency,
      reports: duplicateReports,
      counters,
      transactor,
    }),
  });
  const adminOperations: AdminOperations = createAdminOperations({
    apiKeys,
    accessConfig,
    audit: adminAudit,
    clock,
    deletions: {
      requests: deletionRequests,
      listings: deletionListings,
      blocklist: deletionBlocklist,
      // In AWS a Step Functions execution; locally the workflow runs in-process.
      starter: new InProcessDeletionWorkflowStarter(deletionWorkflow),
    },
  });
  // There are no Lambda functions to restart: report the three targets as reloaded.
  let configVersion = 0;
  const reload = async (): Promise<ReloadOutcome[]> => {
    const previous = configVersion === 0 ? null : String(configVersion);
    configVersion += 1;
    return ['local-search-api', 'local-mcp', 'local-connectors'].map((functionName) => ({
      functionName,
      status: 'updated' as const,
      previousConfigVersion: previous,
      configVersion: String(configVersion),
    }));
  };

  // ---- Duplikat_Abgleich (in AWS: state machine, daily schedule) ----------------------------
  // Locally the run happens in this process, started via `POST /platform/duplicate-sweeps`
  // (duplicate-detection Req 10.2); there is no daily schedule.
  const duplicateSweep = new DuplicateSweep({
    listings,
    index: duplicateIndex,
    reports: duplicateReports,
    counters,
    transactor,
    writer,
    detector,
    audit,
    clock,
    frontendOrigin,
  });
  const logger = options.logger ?? {
    error: (message: string, attributes: Record<string, unknown>) =>
      console.error(message, attributes),
  };
  const sweepStarter = new InProcessDuplicateSweepStarter({
    clock,
    run: async (sweepId, startedAt) => {
      try {
        await runDuplicateSweep(
          duplicateSweep,
          { sweepId, startedAt },
          config.duplicateDetection.sweep.segments,
        );
      } catch (error) {
        logger.error('Duplicate sweep failed', {
          errorName: error instanceof Error ? error.name : typeof error,
        });
        throw error;
      }
    },
  });
  const duplicateReportService = new DuplicateReportService({
    reports: duplicateReports,
    counters,
    transactor,
    audit,
    clock,
    starter: sweepStarter,
    detection: duplicateDetection,
  });

  // ---- connectors (import pipeline on the same stores) ---------------------------------------
  const pipeline = new ImportPipeline({
    listingSchema: buildSchemas(config.taxonomy, config.locales).listing,
    reader: { listings, keys, blocklist },
    writer,
    piiAllowlist: config.piiAllowlist,
    tourProviders: config.tourProviders,
    taxonomy: config.taxonomy,
    duplicates: detector,
    detection: duplicateDetection,
    clock,
  });
  const connectorFramework = new ConnectorFramework({
    registry: new ConnectorRegistry(options.connectorModules ?? []),
    processor: pipeline,
    runs: connectorRuns,
    // Run log lines are dropped; the persisted runs show up in the monitoring.
    sink: () => undefined,
    now: () => new Date(clock()),
  });

  // ---- local OIDC provider and Management_API ----------------------------------------------
  const userHints = options.userHints ?? {};
  async function demoUsers(): Promise<DemoUser[]> {
    const page = { limit: 1000 };
    const admins = await memberships.listPlatformAdmins(page);
    const result: DemoUser[] = admins.items.map((m) => ({
      userId: m.userId,
      email: m.email,
      displayName: m.displayName,
      role: m.role,
      ...(userHints[m.userId] !== undefined && { hint: userHints[m.userId] }),
    }));
    for (const state of ['ACTIVE', 'SUSPENDED'] as const) {
      for (const agency of (await agencies.listByState(state, page)).items) {
        for (const m of (await memberships.listByAgency(agency.agencyId, page)).items) {
          const hint = userHints[m.userId];
          result.push({
            userId: m.userId,
            email: m.email,
            displayName: m.displayName,
            role: m.role,
            agencyName: `${agency.displayName}${state === 'SUSPENDED' ? ' (suspended)' : ''}`,
            ...(hint !== undefined && { hint }),
          });
        }
      }
    }
    return result;
  }
  const oidc = new DevOidcProvider({
    issuer: options.issuer,
    clientId: options.clientId,
    users: demoUsers,
    clock,
  });

  const authenticator = new CachingAuthenticator({
    // DEV ONLY: tokens of the local provider instead of the Cognito verifier.
    tokenVerifier: oidc.accessTokenVerifier(),
    memberships,
    agencies,
    machineAccesses: machineAccessStore,
    clock,
    cacheTtlMs: DEV_CACHE_TTL_MS,
  });
  const routes = [
    ...createIdentityRouteList({
      agencies: agencyService,
      memberships: membershipService,
      machineAccess: machineAccessService,
      overview: new AgencyOverview({ agencies, memberships, counters }),
      machineAccessStore,
    }),
    ...createListingRoutes({
      queries,
      versions: versionService,
      commands: async () => commands,
    }),
    ...createMonitoringRoutes({
      auditLog: audit,
      monitoring,
      queries: monitoringQueries,
      audit,
      clock,
    }),
    ...createPlatformRoutes({
      operations: () => adminOperations,
      deletionTargets: () => deletionListings,
      reload,
    }),
    ...createDuplicateRoutes({ service: () => duplicateReportService }),
  ];
  routes.push(createOpenApiRoute(routes));
  const management: ManagementHandler = createManagementHandler({
    router: createRouter(routes),
    guard: createManagementAccessGuard({
      authenticator,
      rateLimit: new StaticRateLimitSource(DEV_RATE_LIMIT),
      counters: new InMemoryRateLimitCounterStore(),
      clock,
    }),
    audit,
    logger,
  });

  return {
    clock: options.clock,
    handlers: { search, mcp, management },
    oidc,
    demoUsers,
    readModel,
    stores: {
      transactor,
      audit,
      adminAudit,
      agencies,
      memberships,
      platformCounters,
      machineAccessStore,
      counters,
      listings,
      versions,
      keys,
      snapshots,
      blocklist,
      connectorRuns,
      directory,
      apiKeys,
      deletionRequests,
      duplicateIndex,
      duplicateReports,
      idempotency,
    },
    services: {
      agencies: agencyService,
      memberships: membershipService,
      machineAccess: machineAccessService,
      commands,
      queries,
      versions: versionService,
      writer,
      adminOperations,
      duplicateReports: duplicateReportService,
      duplicateDetection,
      /** Waits for a running Duplikat_Abgleich (tests). */
      sweepIdle: () => sweepStarter.idle(),
    },
    runConnector: connectorFramework.runConnector.bind(connectorFramework),
  };
}
