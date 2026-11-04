// CDK app entry (`cdk.json` → `node dist/app.js`). Select the environment with `-c env=<name>` (default `dev`).
// Account/region come from the CLI profile when deploying; without credentials the stacks stay
// environment-agnostic, so `cdk synth` needs no AWS access.
import { App } from 'aws-cdk-lib';
import { AdminStack } from './admin-stack';
import { ApiStack } from './api-stack';
import { ENV_CONTEXT_KEY, resolveEnvironment, resolvePlatformSettings } from './config';
import { DataStack, frontendOriginParameterName } from './data-stack';
import {
  FrontendStack,
  frontendRuntimeSources,
  tourProvidersFromConfigFiles,
} from './frontend-stack';
import { connectorsFromConfigFiles, IngestionStack } from './ingestion-stack';
import { MonitoringStack } from './monitoring-stack';
import { SearchStack } from './search-stack';

const app = new App();
const config = resolveEnvironment(app.node.tryGetContext(ENV_CONTEXT_KEY));
// Overrides via context, e.g. `-c defaultCurrency=THB -c configDir=../../my-config`; validated here.
const settings = resolvePlatformSettings((key) => app.node.tryGetContext(key));

const account = process.env['CDK_DEFAULT_ACCOUNT'];
const region = process.env['CDK_DEFAULT_REGION'];
const env = account && region ? { account, region } : undefined;

// Written by the FrontendStack, read by the Search_API by name: breaks the cycle API URL ⇄ origin.
const frontendOriginParameter = frontendOriginParameterName(config.envName);

const data = new DataStack(app, `${config.stackPrefix}-Data`, {
  ...(env && { env }),
  environment: config,
  settings,
});

// Optional OpenSearch index (`-c searchProvider=opensearch`); the DataStack enables the stream.
const search =
  settings.searchProvider === 'opensearch'
    ? new SearchStack(app, `${config.stackPrefix}-Search`, {
        ...(env && { env }),
        envName: config.envName,
        listings: data.listingsTable,
        removalPolicy: config.removalPolicy,
      })
    : undefined;

const api = new ApiStack(app, `${config.stackPrefix}-Api`, {
  ...(env && { env }),
  tables: {
    listings: data.listingsTable,
    apiKeys: data.apiKeysTable,
    rateLimitCounters: data.rateLimitCountersTable,
  },
  config: { configBucket: data.configBucket, parameterNames: data.parameterNames },
  cors: { frontendOriginParameter, allowedOrigins: settings.corsAllowedOrigins },
  stageName: config.stageName,
  removalPolicy: config.removalPolicy,
  searchProvider: settings.searchProvider,
  ...(search && { openSearch: search.target }),
  wafRateLimit: settings.wafRateLimit,
});

// Latency alarms and dashboard; only references Api (and Search), so it adds no cycle.
new MonitoringStack(app, `${config.stackPrefix}-Monitoring`, {
  ...(env && { env }),
  api,
  ...(search && { search }),
  removalPolicy: config.removalPolicy,
});

const ingestion = new IngestionStack(app, `${config.stackPrefix}-Ingestion`, {
  ...(env && { env }),
  tables: { listings: data.listingsTable, deletionBlocklist: data.deletionBlocklistTable },
  configBucket: data.configBucket,
  connectors: connectorsFromConfigFiles(data.configFiles),
  removalPolicy: config.removalPolicy,
});

new AdminStack(app, `${config.stackPrefix}-Admin`, {
  ...(env && { env }),
  tables: {
    listings: data.listingsTable,
    apiKeys: data.apiKeysTable,
    deletionRequests: data.deletionRequestsTable,
    deletionBlocklist: data.deletionBlocklistTable,
    auditLog: data.auditLogTable,
  },
  parameterNames: data.parameterNames,
  // Everything that loads taxonomy or allowlists at init (design: „Neustart“).
  reloadableFunctions: [
    api.listingsFunction,
    api.mcpFunction,
    ...ingestion.connectors.map((connector) => connector.function),
  ],
  stageName: config.stageName,
  removalPolicy: config.removalPolicy,
});

// Needs the build output (`npm run build`); fails synth with a hint otherwise.
new FrontendStack(app, `${config.stackPrefix}-Frontend`, {
  ...(env && { env }),
  assetDir: settings.frontendAssetDir,
  // The same `i18n-config.json` the DataStack mirrors into the config bucket.
  runtimeSources: frontendRuntimeSources(settings.i18nConfigFile),
  apiUrl: api.api.url,
  tourProviders: tourProvidersFromConfigFiles(data.configFiles),
  frontendOriginParameter,
  removalPolicy: config.removalPolicy,
  priceClass: settings.frontendPriceClass,
});
