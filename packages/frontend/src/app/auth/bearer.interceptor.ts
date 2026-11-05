import type { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { OidcSecurityService } from 'angular-auth-oidc-client';
import { switchMap, take } from 'rxjs';
import { isManagementApiUrl } from './portal-auth-model';
import { PortalConfigService } from './portal-config.service';

/**
 * Attaches `Authorization: Bearer <access token>` to Management_API calls only (Req 2.3); the
 * Search_API, Cognito and static files never see the token.
 */
export const bearerInterceptor: HttpInterceptorFn = (request, next) => {
  const portalConfig = inject(PortalConfigService);
  const state = portalConfig.state();
  if (
    !state.ok ||
    !isManagementApiUrl(request.url, state.config.managementApiUrl, portalConfig.origin())
  ) {
    return next(request);
  }
  const oidc = inject(OidcSecurityService);
  return oidc.getAccessToken().pipe(
    take(1),
    switchMap((token) =>
      next(token ? request.clone({ setHeaders: { Authorization: `Bearer ${token}` } }) : request),
    ),
  );
};
