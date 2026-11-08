import {
  CachingAuthenticator,
  InMemoryAgencyStore,
  InMemoryMachineAccessStore,
  InMemoryMembershipStore,
  cognitoAccessTokenVerifier,
  hashMachineSecret,
  type AccessTokenVerifier,
  type AgencyRecord,
  type MachineAccessRecord,
  type MembershipRecord,
} from '@open-estate/core';

const CREATED = '2026-01-01T00:00:00.000Z';
const T0 = Date.parse('2026-03-01T12:00:00.000Z');
const SECRET = 's3cr3t_with_underscore';

const agency = (agencyId: string, state: AgencyRecord['state'] = 'ACTIVE'): AgencyRecord => ({
  agencyId,
  displayName: `Agency ${agencyId}`,
  state,
  createdAt: CREATED,
  agencyAdmins: 1,
});

const member = (
  userId: string,
  role: MembershipRecord['role'],
  agencyId?: string,
): MembershipRecord => ({
  userId,
  email: `${userId}@example.test`,
  displayName: `User ${userId}`,
  role,
  ...(agencyId !== undefined && { agencyId }),
  createdAt: CREATED,
});

const machine = (
  keyId: string,
  overrides: Partial<MachineAccessRecord> = {},
): MachineAccessRecord => ({
  keyId,
  agencyId: 'a1',
  label: `Key ${keyId}`,
  keyHash: hashMachineSecret(SECRET),
  permissions: ['listing:read', 'listing:write'],
  createdBy: 'u-admin',
  createdAt: CREATED,
  ...overrides,
});

/** Token `valid-<sub>` verifies to `<sub>`; everything else is invalid. */
const fakeVerifier: AccessTokenVerifier = {
  verify: async (token) => (token.startsWith('valid-') ? token.slice('valid-'.length) : null),
};

function setup() {
  let now = T0;
  const agencies = new InMemoryAgencyStore([agency('a1'), agency('a2', 'SUSPENDED')]);
  const memberships = new InMemoryMembershipStore([
    member('u-member', 'AGENCY_MEMBER', 'a1'),
    member('u-admin', 'AGENCY_ADMIN', 'a1'),
    member('u-suspended', 'AGENCY_MEMBER', 'a2'),
    member('u-platform', 'PLATFORM_ADMIN'),
  ]);
  const machineAccesses = new InMemoryMachineAccessStore([
    machine('k1'),
    machine('k-revoked', { revokedAt: CREATED }),
    machine('k-expired', { expiresAt: new Date(T0).toISOString() }),
    machine('k-future', { expiresAt: new Date(T0 + 1).toISOString() }),
    machine('k-suspended', { agencyId: 'a2' }),
  ]);
  const authenticator = new CachingAuthenticator({
    tokenVerifier: fakeVerifier,
    memberships,
    agencies,
    machineAccesses,
    clock: () => now,
  });
  const advance = (ms: number) => {
    now += ms;
  };
  return { authenticator, agencies, memberships, machineAccesses, advance };
}

const errorCode = (result: { ok: boolean; error?: { code: string } }) =>
  result.ok ? 'OK' : result.error?.code;

describe('CachingAuthenticator', () => {
  it.each([undefined, '', '   '])(
    'rejects a missing Authorization %p with AUTH_MISSING',
    async (h) => {
      const { authenticator } = setup();
      expect(errorCode(await authenticator.authenticate(h))).toBe('AUTH_MISSING');
    },
  );

  it.each(['Basic dXNlcjpwdw==', 'Bearer', 'valid-u-member', 'Bearer a b'])(
    'rejects the malformed header %p with AUTH_INVALID',
    async (header) => {
      const { authenticator } = setup();
      expect(errorCode(await authenticator.authenticate(header))).toBe('AUTH_INVALID');
    },
  );

  describe('users (Req 1.3)', () => {
    it('resolves role and agency from the membership', async () => {
      const { authenticator } = setup();
      expect(await authenticator.authenticate('Bearer valid-u-admin')).toEqual({
        ok: true,
        value: {
          kind: 'user',
          userId: 'u-admin',
          displayName: 'User u-admin',
          role: 'AGENCY_ADMIN',
          agencyId: 'a1',
        },
      });
    });

    it('accepts a case-insensitive scheme', async () => {
      const { authenticator } = setup();
      expect(errorCode(await authenticator.authenticate('bearer valid-u-member'))).toBe('OK');
    });

    it('resolves a Plattform_Admin without agency', async () => {
      const { authenticator } = setup();
      expect(await authenticator.authenticate('Bearer valid-u-platform')).toEqual({
        ok: true,
        value: {
          kind: 'user',
          userId: 'u-platform',
          displayName: 'User u-platform',
          role: 'PLATFORM_ADMIN',
        },
      });
    });

    it('rejects an invalid token and an account without membership (Req 2.4)', async () => {
      const { authenticator } = setup();
      expect(errorCode(await authenticator.authenticate('Bearer forged'))).toBe('AUTH_INVALID');
      expect(errorCode(await authenticator.authenticate('Bearer valid-u-none'))).toBe(
        'AUTH_INVALID',
      );
    });

    it('rejects members of a suspended agency with AGENCY_SUSPENDED (Req 1.8)', async () => {
      const { authenticator } = setup();
      expect(errorCode(await authenticator.authenticate('Bearer valid-u-suspended'))).toBe(
        'AGENCY_SUSPENDED',
      );
    });

    it('names the identified member of a suspended agency for the audit (Req 2.8)', async () => {
      const { authenticator } = setup();
      const result = await authenticator.authenticate('Bearer valid-u-suspended');
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'AGENCY_SUSPENDED' },
        principal: { kind: 'user', userId: 'u-suspended', role: 'AGENCY_MEMBER', agencyId: 'a2' },
      });
      // Unidentified refusals stay anonymous.
      expect(await authenticator.authenticate('Bearer forged')).not.toHaveProperty('principal');
    });

    it('applies a role change after the 60 s cache, not before (Req 1.6)', async () => {
      const { authenticator, memberships, advance } = setup();
      const before = await authenticator.authenticate('Bearer valid-u-member');
      expect(before.ok && before.value.kind === 'user' && before.value.role).toBe('AGENCY_MEMBER');

      memberships.changeRoleOp('u-member', 'a1', 'AGENCY_MEMBER', 'AGENCY_ADMIN').apply();
      advance(59_999);
      const cached = await authenticator.authenticate('Bearer valid-u-member');
      expect(cached.ok && cached.value.kind === 'user' && cached.value.role).toBe('AGENCY_MEMBER');

      advance(1);
      const fresh = await authenticator.authenticate('Bearer valid-u-member');
      expect(fresh.ok && fresh.value.kind === 'user' && fresh.value.role).toBe('AGENCY_ADMIN');
    });

    it('applies a removal and a suspension within 60 s (Req 1.6, 1.8)', async () => {
      const { authenticator, memberships, agencies, advance } = setup();
      expect(errorCode(await authenticator.authenticate('Bearer valid-u-admin'))).toBe('OK');
      expect(errorCode(await authenticator.authenticate('Bearer valid-u-member'))).toBe('OK');

      memberships.deleteOp('u-admin', { role: 'AGENCY_ADMIN', agencyId: 'a1' }).apply();
      await agencies.update('a1', { state: 'SUSPENDED' });
      advance(60_000);

      expect(errorCode(await authenticator.authenticate('Bearer valid-u-admin'))).toBe(
        'AUTH_INVALID',
      );
      expect(errorCode(await authenticator.authenticate('Bearer valid-u-member'))).toBe(
        'AGENCY_SUSPENDED',
      );
    });
  });

  describe('machine accesses (Req 3.4–3.6)', () => {
    it('authenticates with exactly the stored permissions and agency (Req 3.4)', async () => {
      const { authenticator } = setup();
      expect(await authenticator.authenticate(`Bearer oem_k1_${SECRET}`)).toEqual({
        ok: true,
        value: {
          kind: 'machine',
          keyId: 'k1',
          label: 'Key k1',
          agencyId: 'a1',
          permissions: ['listing:read', 'listing:write'],
        },
      });
    });

    it.each([
      ['wrong secret', 'oem_k1_wrong'],
      ['unknown key', `oem_k-unknown_${SECRET}`],
      ['revoked key', `oem_k-revoked_${SECRET}`],
      ['missing secret', 'oem_k1_'],
      ['missing key id', `oem__${SECRET}`],
      ['no separator', 'oem_k1'],
      ['expired key with wrong secret', 'oem_k-expired_wrong'],
    ])('rejects a %s with AUTH_INVALID', async (_case, credential) => {
      const { authenticator } = setup();
      expect(errorCode(await authenticator.authenticate(`Bearer ${credential}`))).toBe(
        'AUTH_INVALID',
      );
    });

    it('rejects a key with a malformed stored hash', async () => {
      const { authenticator, machineAccesses } = setup();
      await machineAccesses.create(machine('k-badhash', { keyHash: 'not-hex' }));
      expect(errorCode(await authenticator.authenticate(`Bearer oem_k-badhash_${SECRET}`))).toBe(
        'AUTH_INVALID',
      );
    });

    it('marks expiry with MACHINE_ACCESS_EXPIRED from expiresAt on (Req 3.6)', async () => {
      const { authenticator, advance } = setup();
      expect(errorCode(await authenticator.authenticate(`Bearer oem_k-expired_${SECRET}`))).toBe(
        'MACHINE_ACCESS_EXPIRED',
      );
      expect(errorCode(await authenticator.authenticate(`Bearer oem_k-future_${SECRET}`))).toBe(
        'OK',
      );
      advance(1);
      expect(errorCode(await authenticator.authenticate(`Bearer oem_k-future_${SECRET}`))).toBe(
        'MACHINE_ACCESS_EXPIRED',
      );
    });

    it('rejects keys of a suspended agency with AGENCY_SUSPENDED (Req 1.8)', async () => {
      const { authenticator } = setup();
      expect(errorCode(await authenticator.authenticate(`Bearer oem_k-suspended_${SECRET}`))).toBe(
        'AGENCY_SUSPENDED',
      );
    });

    it('names the identified key of a suspended agency for the audit (Req 2.8)', async () => {
      const { authenticator } = setup();
      const result = await authenticator.authenticate(`Bearer oem_k-suspended_${SECRET}`);
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'AGENCY_SUSPENDED' },
        principal: { kind: 'machine', keyId: 'k-suspended', agencyId: 'a2' },
      });
      // A wrong secret does not identify anybody.
      expect(
        await authenticator.authenticate(`Bearer oem_k-suspended_${'x'.repeat(SECRET.length)}`),
      ).not.toHaveProperty('principal');
    });

    it('applies a revocation within 60 s (Req 3.5)', async () => {
      const { authenticator, machineAccesses, advance } = setup();
      expect(errorCode(await authenticator.authenticate(`Bearer oem_k1_${SECRET}`))).toBe('OK');
      await machineAccesses.revoke('k1', new Date(T0).toISOString());
      advance(59_999);
      expect(errorCode(await authenticator.authenticate(`Bearer oem_k1_${SECRET}`))).toBe('OK');
      advance(1);
      expect(errorCode(await authenticator.authenticate(`Bearer oem_k1_${SECRET}`))).toBe(
        'AUTH_INVALID',
      );
    });

    it('writes lastUsedAt at most once per minute', async () => {
      const { authenticator, machineAccesses, advance } = setup();
      const touch = jest.spyOn(machineAccesses, 'touchLastUsed');

      await authenticator.authenticate(`Bearer oem_k1_${SECRET}`);
      expect((await machineAccesses.get('k1'))?.lastUsedAt).toBe(new Date(T0).toISOString());
      advance(30_000);
      await authenticator.authenticate(`Bearer oem_k1_${SECRET}`);
      expect(touch).toHaveBeenCalledTimes(1);

      advance(30_000);
      await authenticator.authenticate(`Bearer oem_k1_${SECRET}`);
      expect(touch).toHaveBeenCalledTimes(2);
      expect((await machineAccesses.get('k1'))?.lastUsedAt).toBe(
        new Date(T0 + 60_000).toISOString(),
      );
    });

    it('does not write lastUsedAt for rejected calls', async () => {
      const { authenticator, machineAccesses } = setup();
      const touch = jest.spyOn(machineAccesses, 'touchLastUsed');
      await authenticator.authenticate('Bearer oem_k1_wrong');
      await authenticator.authenticate(`Bearer oem_k-suspended_${SECRET}`);
      expect(touch).not.toHaveBeenCalled();
    });

    it('still authenticates when the lastUsedAt write fails', async () => {
      const { authenticator, machineAccesses } = setup();
      jest.spyOn(machineAccesses, 'touchLastUsed').mockRejectedValue(new Error('throttled'));
      expect(errorCode(await authenticator.authenticate(`Bearer oem_k1_${SECRET}`))).toBe('OK');
    });
  });
});

describe('cognitoAccessTokenVerifier', () => {
  const verifier = cognitoAccessTokenVerifier({
    userPoolId: 'eu-central-1_abcdefghi',
    clientId: 'portal-client',
  });

  it.each(['not-a-jwt', 'a.b.c', ''])(
    'maps the unparseable token %p to null without fetching the JWKS',
    async (token) => {
      await expect(verifier.verify(token)).resolves.toBeNull();
    },
  );
});
