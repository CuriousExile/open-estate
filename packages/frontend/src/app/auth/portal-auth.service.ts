import { DOCUMENT } from '@angular/common';
import { inject, Injectable } from '@angular/core';
import { Router, type UrlTree } from '@angular/router';
import { OidcSecurityService } from 'angular-auth-oidc-client';
import { firstValueFrom } from 'rxjs';
import {
  cognitoLogoutUrl,
  decideAuth,
  isAuthCallback,
  rememberReturnUrl,
  takeReturnUrl,
} from './portal-auth-model';
import { PortalConfigService } from './portal-config.service';
import { PortalSession } from './portal-session.service';
import { tabStorage } from './tab-storage';

/** Notice routes outside the guarded portal shell (no redirect loops). */
export const PORTAL_UNAVAILABLE_PATH = '/portal/unavailable';

/** Portal login and logout over OIDC (Req 5.1). */
@Injectable({ providedIn: 'root' })
export class PortalAuth {
  private readonly oidc = inject(OidcSecurityService);
  private readonly portalConfig = inject(PortalConfigService);
  private readonly session = inject(PortalSession);
  private readonly router = inject(Router);
  private readonly document = inject(DOCUMENT);
  private readonly storage = tabStorage(this.document);

  /**
   * Guard logic: completes a login callback and returns to the remembered route, lets
   * authenticated users pass, and starts the login for everybody else.
   */
  async ensureAuthenticated(requestedUrl: string): Promise<boolean | UrlTree> {
    if (!this.portalConfig.state().ok) return this.unavailable('notConfigured');
    const currentUrl = this.document.location.href;
    const callback = isAuthCallback(currentUrl);
    let authenticated: boolean;
    try {
      authenticated = (await firstValueFrom(this.oidc.checkAuth(currentUrl))).isAuthenticated;
    } catch (error) {
      console.error('[portal] login check failed', { error: String(error) });
      return this.unavailable(callback ? 'loginFailed' : 'notConfigured');
    }
    const decision = decideAuth({
      authenticated,
      callback,
      requestedUrl,
      storedReturnUrl: callback ? takeReturnUrl(this.storage) : undefined,
    });
    switch (decision.kind) {
      case 'allow':
        return true;
      case 'redirect':
        return this.router.parseUrl(decision.url);
      case 'failed':
        return this.unavailable('loginFailed');
      case 'login':
        rememberReturnUrl(this.storage, decision.returnUrl);
        this.session.reset();
        this.oidc.authorize();
        return false;
    }
  }

  /** Ends the local and the Cognito session, then returns to the public search. */
  logout(): void {
    const state = this.portalConfig.state();
    this.session.reset();
    this.oidc.logoffLocal();
    if (state.ok) {
      this.document.location.assign(cognitoLogoutUrl(state.config, this.portalConfig.origin()));
    } else {
      void this.router.navigateByUrl('/');
    }
  }

  private unavailable(reason: 'notConfigured' | 'loginFailed'): UrlTree {
    return this.router.createUrlTree([PORTAL_UNAVAILABLE_PATH], { queryParams: { reason } });
  }
}
