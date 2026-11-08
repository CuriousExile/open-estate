// DEV ONLY: the SPA's `runtime-config.json` for the local demo. In AWS the ManagementStack writes
// this file with the deployed endpoints; locally the dev server knows its own address, so it
// serves the file itself (through the `ng serve` proxy) and no port is hard-coded in the SPA.

/** Path under which the SPA loads its runtime configuration (`initialize.ts`). */
export const RUNTIME_CONFIG_PATH = '/runtime-config.json';

export interface LocalRuntimeConfigOptions {
  /** Absolute issuer URL of the local OIDC provider, e.g. `http://127.0.0.1:4310/oidc`. */
  issuer: string;
  /** The portal's public client id. */
  clientId: string;
  /** Search_API base as the SPA reaches it (through the proxy), e.g. `/api`. */
  apiBaseUrl: string;
  /** Management_API base as the SPA reaches it (through the proxy), e.g. `/management`. */
  managementApiUrl: string;
}

/** Content of `runtime-config.json` (shape: `RuntimeConfigSchema`, `PortalConfigSchema`). */
export function localRuntimeConfig(options: LocalRuntimeConfigOptions) {
  return {
    apiBaseUrl: options.apiBaseUrl,
    portal: {
      issuer: options.issuer,
      // The local provider serves `/logout` itself, like the Cognito domain does.
      cognitoDomainUrl: options.issuer,
      clientId: options.clientId,
      managementApiUrl: options.managementApiUrl,
    },
  };
}
