import { inject, type EnvironmentProviders } from '@angular/core';
import { provideAuth, StsConfigHttpLoader, StsConfigLoader } from 'angular-auth-oidc-client';
import { defer, of, throwError } from 'rxjs';
import { buildOidcConfig } from './portal-auth-model';
import { PortalConfigService } from './portal-config.service';

/**
 * OIDC client (`angular-auth-oidc-client`, pinned): Code + PKCE against Cognito, tokens in the
 * library's default `sessionStorage` storage. The configuration is read lazily from
 * `runtime-config.json` on the first login check — after the app initializer has loaded it.
 */
export function provideOidcAuth(): EnvironmentProviders {
  return provideAuth({
    loader: {
      provide: StsConfigLoader,
      useFactory: () => {
        const portalConfig = inject(PortalConfigService);
        return new StsConfigHttpLoader(
          defer(() => {
            const state = portalConfig.state();
            return state.ok
              ? of(buildOidcConfig(state.config, portalConfig.origin()))
              : throwError(() => new Error(`portal config ${state.reason}`));
          }),
        );
      },
    },
  });
}
