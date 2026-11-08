import { DOCUMENT } from '@angular/common';
import { computed, inject, Injectable, signal } from '@angular/core';
import type { Permission } from '@open-estate/shared';
import { ManagementApiClient } from '../management/management-api-client.service';
import type { ManagementResult } from '../management/management-client';
import {
  can,
  isPlatformAdmin,
  satisfies,
  visibleNavItems,
  type AccessRequirement,
  type Me,
} from './portal-access';
import { clearSignedIn, markSignedIn } from './portal-auth-model';
import { tabStorage } from './tab-storage';

/**
 * `GET /me` of the signed-in user, loaded once per login. `can()` decides which controls the portal
 * shows (Req 5.6); the Management_API still checks every call.
 */
@Injectable({ providedIn: 'root' })
export class PortalSession {
  private readonly api = inject(ManagementApiClient);
  private readonly storage = tabStorage(inject(DOCUMENT));
  private readonly current = signal<Me | undefined>(undefined);
  private pending: Promise<ManagementResult<Me>> | undefined;

  readonly me = this.current.asReadonly();
  readonly platformAdmin = computed(() => isPlatformAdmin(this.current()));
  readonly navItems = computed(() => visibleNavItems(this.current()));

  /** Loads `/me` once; a failed load is retried on the next call. */
  load(): Promise<ManagementResult<Me>> {
    const me = this.current();
    if (me) return Promise.resolve({ ok: true, value: me });
    this.pending ??= this.api.getMe().then((result) => {
      if (result.ok) {
        this.current.set(result.value);
        // Public pages show this user's manage controls (PortalPresence).
        markSignedIn(this.storage);
      } else this.pending = undefined;
      return result;
    });
    return this.pending;
  }

  can(permission: Permission): boolean {
    return can(this.current(), permission);
  }

  satisfies(requirement: AccessRequirement | undefined): boolean {
    return satisfies(this.current(), requirement);
  }

  reset(): void {
    this.current.set(undefined);
    this.pending = undefined;
    clearSignedIn(this.storage);
  }
}
