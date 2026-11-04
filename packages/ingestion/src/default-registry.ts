import { externalApiModule, type ExternalApiDeps } from './connectors/external-api';
import { relationalDbModule, type RelationalDbDeps } from './connectors/relational-db';
import { SecretsManagerSecretResolver, type SecretResolver } from './connectors/secrets';
import { createWebCrawlerModule, type WebCrawlerModuleOptions } from './crawler/crawler-connector';
import { ConnectorRegistry, type ConnectorModule } from './registry';

/** Runtime dependencies of the bundled connector modules, one entry per module. */
export interface DefaultRegistryDeps {
  readonly webCrawler: WebCrawlerModuleOptions;
  /** Resolves `secretRef` for `relational-db` / `external-api`; defaults to AWS Secrets Manager. */
  readonly secrets?: SecretResolver;
  readonly relationalDb?: Omit<RelationalDbDeps, 'secrets'>;
  readonly externalApi?: Omit<ExternalApiDeps, 'secrets'>;
}

/**
 * Registry with every connector module shipped with open-estate; `connectors.json`
 * selects among them by `module`. New bundled modules are added here, the framework
 * core stays untouched (Req 5.1).
 */
export function createDefaultRegistry(deps: DefaultRegistryDeps): ConnectorRegistry {
  const secrets = deps.secrets ?? new SecretsManagerSecretResolver();
  return new ConnectorRegistry([
    createWebCrawlerModule(deps.webCrawler),
    relationalDbModule({ ...deps.relationalDb, secrets }) as ConnectorModule,
    externalApiModule({ ...deps.externalApi, secrets }) as ConnectorModule,
  ]);
}
