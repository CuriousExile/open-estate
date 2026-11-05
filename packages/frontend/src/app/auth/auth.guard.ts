import { inject } from '@angular/core';
import type { CanActivateFn } from '@angular/router';
import { PortalAuth } from './portal-auth.service';

/**
 * Protects the portal (Req 5.1): unauthenticated users are sent to the identity provider and come
 * back to the requested route after the login.
 */
export const authGuard: CanActivateFn = (_route, state) =>
  inject(PortalAuth).ensureAuthenticated(state.url);
