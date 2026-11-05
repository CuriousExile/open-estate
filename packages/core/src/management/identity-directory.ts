import {
  AdminCreateUserCommand,
  ListUsersCommand,
  type AttributeType,
  type CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';

// Identity_Provider access of the MembershipService (design: "Rollen & Agentur": Cognito holds
// only the identity — `sub` and e-mail; roles live in `Memberships`). Unknown e-mail addresses
// get an account with invitation (`AdminCreateUser`, Req 1.5).

/** Identity of a Cognito user; `userId` = `sub` = PK of `Memberships`. */
export interface DirectoryUser {
  userId: string;
  email: string;
  /** Cognito `name` attribute, else the e-mail address. */
  displayName: string;
}

export interface IdentityDirectory {
  /** User with this e-mail address (case-insensitive), `null` if unknown. */
  findByEmail(email: string): Promise<DirectoryUser | null>;
  /**
   * Creates an account with invitation e-mail. If the address got an account in the meantime,
   * returns that account instead (no second invitation).
   */
  invite(email: string): Promise<DirectoryUser>;
}

/** In-memory directory for tests; `invited` lists the addresses that received an invitation. */
export class InMemoryIdentityDirectory implements IdentityDirectory {
  readonly invited: string[] = [];
  private readonly users = new Map<string, DirectoryUser>();
  private nextId = 1;

  constructor(users: readonly DirectoryUser[] = []) {
    for (const user of users) this.users.set(user.email.toLowerCase(), { ...user });
  }

  async findByEmail(email: string): Promise<DirectoryUser | null> {
    const user = this.users.get(email.toLowerCase());
    return user === undefined ? null : { ...user };
  }

  async invite(email: string): Promise<DirectoryUser> {
    const existing = await this.findByEmail(email);
    if (existing !== null) return existing;
    const user = { userId: `invited-${this.nextId++}`, email, displayName: email };
    this.users.set(email.toLowerCase(), user);
    this.invited.push(email);
    return { ...user };
  }
}

export interface CognitoIdentityDirectoryOptions {
  client: CognitoIdentityProviderClient;
  userPoolId: string;
}

/**
 * Cognito User Pool with e-mail as username (no self sign-up). `AdminCreateUser` sends the
 * invitation with a temporary password; the address counts as verified because a Plattform_Admin
 * or Agentur_Admin entered it.
 */
export class CognitoIdentityDirectory implements IdentityDirectory {
  private readonly client: CognitoIdentityProviderClient;
  private readonly userPoolId: string;

  constructor({ client, userPoolId }: CognitoIdentityDirectoryOptions) {
    this.client = client;
    this.userPoolId = userPoolId;
  }

  async findByEmail(email: string): Promise<DirectoryUser | null> {
    const out = await this.client.send(
      new ListUsersCommand({
        UserPoolId: this.userPoolId,
        Filter: `email = "${escapeFilterValue(email)}"`,
        Limit: 1,
      }),
    );
    const user = out.Users?.[0];
    return user === undefined ? null : toDirectoryUser(user.Attributes, email);
  }

  async invite(email: string): Promise<DirectoryUser> {
    try {
      const out = await this.client.send(
        new AdminCreateUserCommand({
          UserPoolId: this.userPoolId,
          Username: email,
          UserAttributes: [
            // config-check-ignore: standard Cognito attribute names, not resource names
            { Name: 'email', Value: email },
            // config-check-ignore: standard Cognito attribute names, not resource names
            { Name: 'email_verified', Value: 'true' },
          ],
          DesiredDeliveryMediums: ['EMAIL'],
        }),
      );
      return toDirectoryUser(out.User?.Attributes, email);
    } catch (error) {
      // Concurrent invitation of the same address: use the account created by the other call.
      if (error instanceof Error && error.name === 'UsernameExistsException') {
        const existing = await this.findByEmail(email);
        if (existing !== null) return existing;
      }
      throw error;
    }
  }
}

/** `ListUsers` filter values are double-quoted; escape backslashes and quotes. */
function escapeFilterValue(value: string): string {
  return value.replace(/["\\]/g, (char) => `\\${char}`);
}

function toDirectoryUser(attributes: AttributeType[] | undefined, email: string): DirectoryUser {
  const attribute = (name: string) => attributes?.find((a) => a.Name === name)?.Value;
  const userId = attribute('sub');
  if (userId === undefined) throw new Error('Cognito user without sub attribute');
  const storedEmail = attribute('email') ?? email;
  return { userId, email: storedEmail, displayName: attribute('name') ?? storedEmail };
}
