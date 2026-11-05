import {
  AdminCreateUserCommand,
  CognitoIdentityProviderClient,
  ListUsersCommand,
  UsernameExistsException,
} from '@aws-sdk/client-cognito-identity-provider';
import { CognitoIdentityDirectory, InMemoryIdentityDirectory } from '@open-estate/core';

const attrs = (values: Record<string, string>) =>
  Object.entries(values).map(([Name, Value]) => ({ Name, Value }));

function directory(send: (command: unknown) => Promise<unknown>) {
  const client = new CognitoIdentityProviderClient({ region: 'eu-central-1' });
  const spy = jest.spyOn(client, 'send').mockImplementation(send as never);
  return { dir: new CognitoIdentityDirectory({ client, userPoolId: 'pool-1' }), spy };
}

describe('CognitoIdentityDirectory', () => {
  it('finds a user by e-mail with an escaped ListUsers filter', async () => {
    const { dir, spy } = directory(async () => ({
      Users: [{ Attributes: attrs({ sub: 's-1', email: 'a"b@example.org', name: 'Ada' }) }],
    }));
    await expect(dir.findByEmail('a"b@example.org')).resolves.toEqual({
      userId: 's-1',
      email: 'a"b@example.org',
      displayName: 'Ada',
    });
    const command = spy.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(ListUsersCommand);
    expect((command as ListUsersCommand).input).toEqual({
      UserPoolId: 'pool-1',
      Filter: 'email = "a\\"b@example.org"',
      Limit: 1,
    });
  });

  it('returns null for an unknown address', async () => {
    const { dir } = directory(async () => ({ Users: [] }));
    await expect(dir.findByEmail('x@example.org')).resolves.toBeNull();
  });

  it('invites via AdminCreateUser with a verified e-mail', async () => {
    const { dir, spy } = directory(async () => ({
      User: { Attributes: attrs({ sub: 's-2', email: 'new@example.org' }) },
    }));
    await expect(dir.invite('new@example.org')).resolves.toEqual({
      userId: 's-2',
      email: 'new@example.org',
      displayName: 'new@example.org',
    });
    const command = spy.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(AdminCreateUserCommand);
    expect((command as AdminCreateUserCommand).input).toEqual({
      UserPoolId: 'pool-1',
      Username: 'new@example.org',
      UserAttributes: [
        { Name: 'email', Value: 'new@example.org' },
        { Name: 'email_verified', Value: 'true' },
      ],
      DesiredDeliveryMediums: ['EMAIL'],
    });
  });

  it('falls back to the existing account after a concurrent invitation', async () => {
    const { dir } = directory(async (command) => {
      if (command instanceof AdminCreateUserCommand) {
        throw new UsernameExistsException({ message: 'exists', $metadata: {} });
      }
      return { Users: [{ Attributes: attrs({ sub: 's-3', email: 'new@example.org' }) }] };
    });
    await expect(dir.invite('new@example.org')).resolves.toMatchObject({ userId: 's-3' });
  });

  it('rethrows other errors', async () => {
    const { dir } = directory(async () => {
      throw new Error('boom');
    });
    await expect(dir.invite('new@example.org')).rejects.toThrow('boom');
  });
});

describe('InMemoryIdentityDirectory', () => {
  it('matches e-mail case-insensitively and invites each address once', async () => {
    const dir = new InMemoryIdentityDirectory();
    const first = await dir.invite('New@Example.org');
    await expect(dir.findByEmail('new@example.org')).resolves.toEqual(first);
    await expect(dir.invite('new@example.org')).resolves.toEqual(first);
    expect(dir.invited).toEqual(['New@Example.org']);
  });
});
