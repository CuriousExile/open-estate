import type { App, Environment } from 'aws-cdk-lib';
import { AdminStack } from './admin-stack';
import { ApiStack } from './api-stack';
import { ENV_CONTEXT_KEY, resolveEnvironment, resolvePlatformSettings } from './config';
import { DataStack, frontendOriginParameterName } from './data-stack';
import {
  FrontendStack,
  frontendRuntimeSources,
  tourProvidersFromConfigFiles,
} from './frontend-stack';
import {
  defaultCognitoDomainPrefix,
  IdentityStack,
  resolveIdentitySettings,
} from './identity-stack';
import { connectorsFromConfigFiles, IngestionStack } from './ingestion-stack';
import { duplicateSweepSettings } from './duplicate-sweep';
import { ManagementDataStack, ManagementStack, portalConnectOrigins } from './management-stack';
import { MonitoringStack } from './monitoring-stack';
import { SearchStack } from './search-stack';

// Wiring of the whole platform, shared by `app.ts` and the full-app tests. Deployment order (no
// cycles): Data → ManagementData → (Search) → Api → Monitoring → Ingestion → Admin → Frontend →
// Identity → Management. See `management-stack.ts` for why the management tables live in their
// own early stack and the portal runtime config is written last.

export interface PlatformStacks {
  readonly data: DataStack;
  readonly managementData: ManagementDataStack;
  readonly search?: SearchStack;
  readonly api: ApiStack;
  readonly monitoring: MonitoringStack;
  readonly ingestion: IngestionStack;
  readonly admin: AdminStack;
  readonly frontend: FrontendStack;
  readonly identity: IdentityStack;
  readonly management: ManagementStack;
}

/**
 * Adds every stack to `app`; environment and overrides come from its context (`-c env=<name>`,
 * `-c defaultCurrency=THB`, …), validated here. Without `env` the stacks stay
 * environment-agnostic.
 */
export function buildPlatform(app: App, env?: Environment): PlatformStacks {
  const config = resolveEnvironment(app.node.tryGetContext(ENV_CONTEXT_KEY));
  const settings = resolvePlatformSettings((key) => app.node.tryGetContext(key));
  const identitySettings = resolveIdentitySettings((key) => app.node.tryGetContext(key));
  const prefix = config.stackPrefix;
  const envProps = env === undefined ? {} : { env };

  // Written by the FrontendStack, read by the Search_API and Management_API by name: breaks the
  // cycle API URL ⇄ origin.
  const frontendOriginParameter = frontendOriginParameterName(config.envName);

  const data = new DataStack(app, `${prefix}-Data`, {
    ...envProps,
    environment: config,
    settings,
  });

  // Tables and snapshot bucket of the Listing-Verwaltung, read by API/MCP, connectors and admin.
  const managementData = new ManagementDataStack(app, `${prefix}-ManagementData`, {
    ...envProps,
    removalPolicy: config.removalPolicy,
  });

  // Optional OpenSearch index (`-c searchProvider=opensearch`); the DataStack enables the stream.
  const search =
    settings.searchProvider === 'opensearch'
      ? new SearchStack(app, `${prefix}-Search`, {
          ...envProps,
          envName: config.envName,
          listings: data.listingsTable,
          removalPolicy: config.removalPolicy,
        })
      : undefined;

  const api = new ApiStack(app, `${prefix}-Api`, {
    ...envProps,
    tables: {
      listings: data.listingsTable,
      apiKeys: data.apiKeysTable,
      rateLimitCounters: data.rateLimitCountersTable,
      agencies: managementData.agenciesTable,
    },
    config: { configBucket: data.configBucket, parameterNames: data.parameterNames },
    cors: { frontendOriginParameter, allowedOrigins: settings.corsAllowedOrigins },
    stageName: config.stageName,
    removalPolicy: config.removalPolicy,
    searchProvider: settings.searchProvider,
    ...(search && { openSearch: search.target }),
    wafRateLimit: settings.wafRateLimit,
    observability: settings.observability,
  });

  // Latency alarms and dashboard; only references Api (and Search), so it adds no cycle.
  const monitoringStackId = `${prefix}-Monitoring`;
  const monitoring = new MonitoringStack(app, monitoringStackId, {
    ...envProps,
    api,
    ...(search && { search }),
    removalPolicy: config.removalPolicy,
  });

  const ingestion = new IngestionStack(app, `${prefix}-Ingestion`, {
    ...envProps,
    tables: { listings: data.listingsTable, deletionBlocklist: data.deletionBlocklistTable },
    configBucket: data.configBucket,
    connectors: connectorsFromConfigFiles(data.configFiles),
    versioning: managementData.versioning,
    duplicateDetectionParameter: data.parameterNames.duplicateDetection,
    removalPolicy: config.removalPolicy,
    observability: settings.observability,
  });

  // Everything that loads taxonomy or allowlists at init (design: „Neustart“).
  const reloadableFunctions = [
    api.listingsFunction,
    api.mcpFunction,
    ...ingestion.connectors.map((connector) => connector.function),
  ];

  const admin = new AdminStack(app, `${prefix}-Admin`, {
    ...envProps,
    tables: {
      listings: data.listingsTable,
      apiKeys: data.apiKeysTable,
      deletionRequests: data.deletionRequestsTable,
      deletionBlocklist: data.deletionBlocklistTable,
      auditLog: data.auditLogTable,
    },
    history: managementData.history,
    parameterNames: data.parameterNames,
    reloadableFunctions,
    stageName: config.stageName,
    removalPolicy: config.removalPolicy,
    observability: settings.observability,
  });

  const cognitoDomainPrefix =
    identitySettings.cognitoDomainPrefix ?? defaultCognitoDomainPrefix(config.envName);

  // Needs the build output (`npm run build`); fails synth with a hint otherwise.
  const frontend = new FrontendStack(app, `${prefix}-Frontend`, {
    ...envProps,
    assetDir: settings.frontendAssetDir,
    // The same `i18n-config.json` the DataStack mirrors into the config bucket.
    runtimeSources: frontendRuntimeSources(settings.i18nConfigFile),
    apiUrl: api.api.url,
    tourProviders: tourProvidersFromConfigFiles(data.configFiles),
    frontendOriginParameter,
    removalPolicy: config.removalPolicy,
    priceClass: settings.frontendPriceClass,
    // Management_API and Cognito are created later: deterministic origins only (no reference).
    portalConnectOrigins: portalConnectOrigins(cognitoDomainPrefix),
    // `runtime-config.json` (with the portal block) is written by the ManagementStack.
    writeRuntimeConfig: false,
  });

  // After the FrontendStack: the portal client's callback URLs use its CloudFront origin.
  const identity = new IdentityStack(app, `${prefix}-Identity`, {
    ...envProps,
    envName: config.envName,
    portalOrigins: [frontend.origin, ...settings.corsAllowedOrigins],
    cognitoDomainPrefix,
    removalPolicy: config.removalPolicy,
  });

  const management = new ManagementStack(app, `${prefix}-Management`, {
    ...envProps,
    envName: config.envName,
    stageName: config.stageName,
    removalPolicy: config.removalPolicy,
    observability: settings.observability,
    data: {
      listings: data.listingsTable,
      apiKeys: data.apiKeysTable,
      rateLimitCounters: data.rateLimitCountersTable,
      deletionBlocklist: data.deletionBlocklistTable,
      deletionRequests: data.deletionRequestsTable,
      auditLog: data.auditLogTable,
      configBucket: data.configBucket,
      parameterNames: data.parameterNames,
    },
    stores: managementData,
    identity,
    frontend,
    frontendOriginParameter,
    corsAllowedOrigins: settings.corsAllowedOrigins,
    searchApiUrl: api.api.url,
    usageLogGroups: [api.listingsFunction.logGroup, api.mcpFunction.logGroup],
    reloadableFunctions,
    deletionStateMachine: admin.deletionStateMachine,
    alarmNamePrefix: `${monitoringStackId}-`,
    alarmTopic: monitoring.alarmTopic,
    duplicateSweep: duplicateSweepSettings(data.configFiles),
    wafRateLimit: settings.wafRateLimit,
    rateLimit: settings.rateLimit,
    ...(identitySettings.initialPlatformAdminEmail !== undefined && {
      initialPlatformAdminEmail: identitySettings.initialPlatformAdminEmail,
    }),
  });

  return {
    data,
    managementData,
    ...(search && { search }),
    api,
    monitoring,
    ingestion,
    admin,
    frontend,
    identity,
    management,
  };
}
