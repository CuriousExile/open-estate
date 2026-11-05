// Feature: listing-management, Property 5: Maschinenzugänge – Berechtigungsprüfung und Geheimnis
import {
  CachingAuthenticator,
  hashMachineSecret,
  InMemoryAgencyStore,
  InMemoryMachineAccessStore,
  InMemoryMembershipStore,
  MachineAccessService,
  type MachineAccessAuditEntry,
} from '@open-estate/core';
import {
  CreateMachineAccessRequest,
  GRANTABLE_MACHINE_PERMISSIONS,
  MANAGEMENT_BOUNDS as M,
  PERMISSIONS,
  type Principal,
} from '@open-estate/shared';
import fc from 'fast-check';
import {
  arbAgencyId,
  arbAgencyUserPrincipal,
  arbPlatformAdminPrincipal,
} from '../../../shared/test/arbitraries';

// **Validates: Requirements 3.1, 3.2, 3.3, 3.7**
//
// For any requested permission set, a machine access is created iff the set is a subset of the
// grantable permissions; otherwise the rejection names every ungrantable permission. For any
// created access, the secret returned once authenticates, while the stored record and every
// later representation (views, list, audit) do not contain it.

const T0 = Date.parse('2026-03-01T10:00:00.000Z');
const GRANTABLE: ReadonlySet<string> = new Set(GRANTABLE_MACHINE_PERMISSIONS);
const CREDENTIAL = /^oem_([^_]+)_(.+)$/;

/** Agentur_Admin of the target agency or Plattform_Admin: both may manage machine accesses. */
const arbManager = (agencyId: string): fc.Arbitrary<Principal> =>
  fc.oneof(
    arbAgencyUserPrincipal({ agencyIds: [agencyId] }).map((principal): Principal => ({
      ...principal,
      role: 'AGENCY_ADMIN',
    })),
    arbPlatformAdminPrincipal,
  );

const arbScenario = arbAgencyId.chain((agencyId) =>
  fc.record({
    agencyId: fc.constant(agencyId),
    principal: arbManager(agencyId),
    // Mostly mixed sets, sometimes restricted to grantable ones so both branches are exercised.
    permissions: fc.oneof(
      fc.subarray([...PERMISSIONS], { minLength: 1 }),
      fc.subarray([...GRANTABLE_MACHINE_PERMISSIONS], { minLength: 1 }),
    ),
    // Duplicates in the request must not change the outcome.
    duplicate: fc.boolean(),
    label: fc.string({ minLength: M.machineAccessLabel.min, maxLength: M.machineAccessLabel.max }),
    // Optional expiry in the future, so the fresh secret must authenticate.
    expiresInMs: fc.option(fc.integer({ min: 1, max: 365 * 24 * 3_600_000 }), { nil: undefined }),
  }),
);

function setup(agencyId: string) {
  const store = new InMemoryMachineAccessStore();
  const agencies = new InMemoryAgencyStore([
    {
      agencyId,
      displayName: agencyId,
      state: 'ACTIVE' as const,
      createdAt: new Date(T0).toISOString(),
      agencyAdmins: 1,
    },
  ]);
  const entries: MachineAccessAuditEntry[] = [];
  const clock = () => T0;
  const service = new MachineAccessService({
    store,
    agencies,
    audit: { append: async (entry) => void entries.push(entry) },
    clock,
  });
  const authenticator = new CachingAuthenticator({
    tokenVerifier: { verify: async () => null },
    memberships: new InMemoryMembershipStore([]),
    agencies,
    machineAccesses: store,
    clock,
  });
  return { service, store, entries, authenticator };
}

describe('Property 5: Maschinenzugänge – Berechtigungsprüfung und Geheimnis', () => {
  it('creates iff grantable, names every ungrantable permission, and never exposes the secret', async () => {
    await fc.assert(
      fc.asyncProperty(arbScenario, async (scenario) => {
        const { agencyId, principal, permissions, label, expiresInMs } = scenario;
        const { service, store, entries, authenticator } = setup(agencyId);
        const request = CreateMachineAccessRequest.parse({
          label,
          permissions: scenario.duplicate ? [...permissions, ...permissions] : permissions,
          ...(expiresInMs !== undefined && {
            expiresAt: new Date(T0 + expiresInMs).toISOString(),
          }),
        });
        const actor = { principal, channel: 'PORTAL' as const };
        const ungrantable = permissions.filter((permission) => !GRANTABLE.has(permission));

        const result = await service.create(actor, agencyId, request);
        const listed = await service.list(actor, agencyId, { limit: 100 });
        if (!listed.ok) throw new Error(JSON.stringify(listed.error));

        if (ungrantable.length > 0) {
          // Req 3.3: rejected, every ungrantable permission named exactly once, nothing stored.
          expect(result.ok).toBe(false);
          if (result.ok) return;
          expect(result.error.every((e) => e.code === 'INVALID_PERMISSION')).toBe(true);
          const named = result.error.map((e) => e.details?.['permission']);
          expect(named).toHaveLength(ungrantable.length);
          expect(new Set(named)).toEqual(new Set(ungrantable));
          expect(listed.value.items).toEqual([]);
          return;
        }

        // Req 3.1: created with the requested permissions; the credential is returned once.
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const { secret: credential, ...view } = result.value;
        const match = CREDENTIAL.exec(credential);
        expect(match).not.toBeNull();
        const [, keyId, rawSecret] = match as unknown as [string, string, string];
        expect(view.keyId).toBe(keyId);
        expect(new Set(view.permissions)).toEqual(new Set(permissions));

        // The returned secret authenticates as exactly this machine access.
        const auth = await authenticator.authenticate(`Bearer ${credential}`);
        if (!auth.ok) throw new Error(JSON.stringify(auth.error));
        expect(auth.value).toMatchObject({ kind: 'machine', keyId, agencyId, label });
        expect(new Set(auth.value.kind === 'machine' ? auth.value.permissions : [])).toEqual(
          new Set(permissions),
        );
        // A different secret for the same key does not.
        const forged = await authenticator.authenticate(`Bearer oem_${keyId}_${rawSecret}x`);
        expect(forged.ok).toBe(false);

        // Req 3.2: only the irreversible hash is stored.
        const stored = await store.get(keyId);
        expect(stored?.keyHash).toBe(hashMachineSecret(rawSecret));
        expect(stored?.keyHash).not.toBe(rawSecret);

        // Req 3.7: no later representation carries the secret (or its hash).
        const later = await service.list(actor, agencyId, { limit: 100 });
        if (!later.ok) throw new Error(JSON.stringify(later.error));
        const revoked = await service.revoke(actor, agencyId, keyId);
        if (!revoked.ok) throw new Error(JSON.stringify(revoked.error));
        expect(later.value.items).toHaveLength(1);
        for (const representation of [view, ...later.value.items, revoked.value]) {
          expect(representation).not.toHaveProperty('secret');
          expect(representation).not.toHaveProperty('keyHash');
        }
        const serialized = [stored, view, later.value, revoked.value, entries].map((value) =>
          JSON.stringify(value),
        );
        for (const text of serialized) {
          expect(text).not.toContain(rawSecret);
          expect(text).not.toContain(credential);
        }
      }),
      { numRuns: 100 },
    );
  });
});
