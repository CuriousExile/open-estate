import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  CognitoIdentityDirectory,
  DynamoDbMembershipStore,
  DynamoDbPlatformCounterStore,
  DynamoDbTransactor,
  systemClock,
  type Clock,
  type IdentityDirectory,
  type MembershipStore,
  type PlatformCounterStore,
  type Transactor,
} from '@open-estate/core';

// Bootstrap of the first Plattform_Admin (Req 10.10, design: "Authenticator und Principal"):
// a CDK Trigger runs this Lambda after every deployment that changes it. While the platform has
// no Plattform_Admin (`PlatformCounters.platformAdmins = 0`), the configured e-mail address gets
// a Cognito account with invitation and the membership `PLATFORM_ADMIN` — membership and counter
// in one transaction, like `MembershipService.addPlatformAdmin`. Idempotent: once a
// Plattform_Admin exists, nothing changes.

/** Environment variables set by the `PlatformAdminBootstrap` construct. */
export const PLATFORM_ADMIN_BOOTSTRAP_ENV = {
  userPoolId: 'USER_POOL_ID',
  membershipsTable: 'MEMBERSHIPS_TABLE_NAME',
  platformCountersTable: 'PLATFORM_COUNTERS_TABLE_NAME',
  email: 'INITIAL_PLATFORM_ADMIN_EMAIL',
} as const;

export interface PlatformAdminBootstrapDeps<Op> {
  memberships: MembershipStore<Op>;
  platformCounters: PlatformCounterStore<Op>;
  identity: IdentityDirectory;
  transactor: Transactor<Op>;
  clock: Clock;
}

export type PlatformAdminBootstrapOutcome =
  { status: 'CREATED'; userId: string } | { status: 'SKIPPED'; platformAdmins: number };

/**
 * Creates `email` as Plattform_Admin iff the platform has none. Throws if the account already
 * has a membership (e.g. belongs to an agency, Req 1.2): the deployment fails instead of
 * silently leaving the platform without Plattform_Admin.
 */
export async function bootstrapPlatformAdmin<Op>(
  deps: PlatformAdminBootstrapDeps<Op>,
  email: string,
): Promise<PlatformAdminBootstrapOutcome> {
  const existing = await deps.platformCounters.platformAdmins();
  if (existing > 0) return { status: 'SKIPPED', platformAdmins: existing };

  // An existing account (e.g. after a failed earlier run) gets no second invitation.
  const user = (await deps.identity.findByEmail(email)) ?? (await deps.identity.invite(email));
  const result = await deps.transactor.transact([
    deps.memberships.createOp({
      userId: user.userId,
      email: user.email,
      displayName: user.displayName,
      role: 'PLATFORM_ADMIN',
      createdAt: new Date(deps.clock()).toISOString(),
    }),
    deps.platformCounters.adjustPlatformAdminsOp(1),
  ]);
  if (result.ok) return { status: 'CREATED', userId: user.userId };

  // A concurrent run created a Plattform_Admin in the meantime: nothing left to do.
  const now = await deps.platformCounters.platformAdmins();
  if (now > 0) return { status: 'SKIPPED', platformAdmins: now };
  throw new Error(
    `Initial Plattform_Admin ${email} (user ${user.userId}) already has a membership; ` +
      'remove it or configure another initialPlatformAdminEmail',
  );
}

/** Lambda entry of the CDK Trigger; a thrown error fails the deployment. */
export async function handler(): Promise<PlatformAdminBootstrapOutcome> {
  const env = readEnv(process.env);
  const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const outcome = await bootstrapPlatformAdmin(
    {
      memberships: new DynamoDbMembershipStore({ client: dynamo, tableName: env.membershipsTable }),
      platformCounters: new DynamoDbPlatformCounterStore({
        client: dynamo,
        tableName: env.platformCountersTable,
      }),
      identity: new CognitoIdentityDirectory({
        client: new CognitoIdentityProviderClient({}),
        userPoolId: env.userPoolId,
      }),
      transactor: new DynamoDbTransactor({ client: dynamo }),
      clock: systemClock,
    },
    env.email,
  );
  console.log(JSON.stringify({ message: 'platform-admin.bootstrap', ...outcome }));
  return outcome;
}

type BootstrapEnv = Record<keyof typeof PLATFORM_ADMIN_BOOTSTRAP_ENV, string>;

function readEnv(env: NodeJS.ProcessEnv): BootstrapEnv {
  const names = Object.entries(PLATFORM_ADMIN_BOOTSTRAP_ENV);
  const missing = names.filter(([, name]) => !env[name]?.trim()).map(([, name]) => name);
  if (missing.length > 0) throw new Error(`Missing environment: ${missing.join(', ')}`);
  return Object.fromEntries(
    names.map(([key, name]) => [key, env[name]?.trim() ?? '']),
  ) as BootstrapEnv;
}
