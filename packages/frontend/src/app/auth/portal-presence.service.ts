import { DOCUMENT } from '@angular/common';
import { inject, Injectable } from '@angular/core';
import { OidcSecurityService } from 'angular-auth-oidc-client';
import { firstValueFrom } from 'rxjs';
import { clearSignedIn, wasSignedIn } from './portal-auth-model';
import { PortalConfigService } from './portal-config.service';
import { PortalSession } from './portal-session.service';
import { tabStorage } from './tab-storage';

/**
 * Portal sign-in as seen from the public pages (search, listing page): agency users and platform
 * admins get manage controls there. Never starts a login. Without a sign-in of this tab
 * ({@link wasSignedIn}) it makes no request at all, so anonymous visitors cause no identity
 * provider or Management_API traffic; otherwise it restores the stored session (`checkAuth`, no
 * redirect) and loads `/me` once.
 */
@Injectable({ providedIn: 'root' })
export class PortalPresence {
  private readonly portalConfig = inject(PortalConfigService);
  private readonly oidc = inject(OidcSecurityService);
  private readonly session = inject(PortalSession);
  private readonly storage = tabStorage(inject(DOCUMENT));
  private resolving: Promise<boolean> | undefined;

  /** `/me` of the signed-in user; `undefined` for anonymous visitors. */
  readonly me = this.session.me;

  /** Resolves to `true` if this tab has a usable portal session (then `me()` is set). */
  signedIn(): Promise<boolean> {
    if (this.session.me() !== undefined) return Promise.resolve(true);
    this.resolving ??= this.resolve().finally(() => (this.resolving = undefined));
    return this.resolving;
  }

  private async resolve(): Promise<boolean> {
    if (!this.portalConfig.state().ok || !wasSignedIn(this.storage)) return false;
    const authenticated = await firstValueFrom(this.oidc.checkAuth()).then(
      (result) => result.isAuthenticated,
      () => false,
    );
    if (!authenticated) {
      clearSignedIn(this.storage);
      return false;
    }
    return (await this.session.load()).ok;
  }
}
