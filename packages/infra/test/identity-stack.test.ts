import {
  InMemoryIdentityDirectory,
  InMemoryMembershipStore,
  InMemoryPlatformCounterStore,
  InMemoryTransactor,
} from '@open-estate/core';
import { App, RemovalPolicy, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AttributeType, TableV2 } from 'aws-cdk-lib/aws-dynamodb';
import {
  IdentityStack,
  PlatformAdminBootstrap,
  PORTAL_CALLBACK_PATH,
  resolveIdentitySettings,
} from '../src/identity-stack';
import {
  bootstrapPlatformAdmin,
  PLATFORM_ADMIN_BOOTSTRAP_ENV,
} from '../src/lambda/platform-admin-bootstrap';

const ORIGIN = 'https://d111111abcdef8.cloudfront.net';

// Bundling skipped (see stacks.test.ts).
const newApp = () => new App({ context: { 'aws:cdk:bundling-stacks': [] } });

function synth(removalPolicy = RemovalPolicy.DESTROY) {
  const app = newApp();
  const stack = new IdentityStack(app, 'Identity', {
    envName: 'dev',
    portalOrigins: [ORIGIN, 'http://localhost:4200'],
    removalPolicy,
  });
  return { stack, template: Template.fromStack(stack) };
}

describe('IdentityStack', () => {
  it('creates a User Pool without self sign-up, e-mail as username and Managed Login', () => {
    const { template } = synth();
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
      UsernameAttributes: ['email'],
      UserPoolTier: 'ESSENTIALS',
    });
    template.hasResourceProperties('AWS::Cognito::UserPoolDomain', { ManagedLoginVersion: 2 });
    template.resourceCountIs('AWS::Cognito::ManagedLoginBranding', 1);
  });

  it('configures the portal client for Code + PKCE with refresh token rotation', () => {
    const { template } = synth();
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      GenerateSecret: false,
      AllowedOAuthFlows: ['code'],
      AllowedOAuthFlowsUserPoolClient: true,
      CallbackURLs: [
        `${ORIGIN}${PORTAL_CALLBACK_PATH}`,
        `http://localhost:4200${PORTAL_CALLBACK_PATH}`,
      ],
      ExplicitAuthFlows: Match.not(Match.arrayWith(['ALLOW_REFRESH_TOKEN_AUTH'])),
      RefreshTokenRotation: { Feature: 'ENABLED', RetryGracePeriodSeconds: 10 },
      EnableTokenRevocation: true,
    });
  });

  it.each([
    [RemovalPolicy.DESTROY, 'Delete', 'INACTIVE'],
    [RemovalPolicy.RETAIN, 'Retain', 'ACTIVE'],
  ])('applies removal policy %s to the User Pool', (policy, deletionPolicy, protection) => {
    const { template } = synth(policy);
    template.hasResource('AWS::Cognito::UserPool', {
      DeletionPolicy: deletionPolicy,
      Properties: Match.objectLike({ DeletionProtection: protection }),
    });
  });
});

describe('PlatformAdminBootstrap', () => {
  it('runs a synchronous trigger with pool and table names after the tables', () => {
    const app = newApp();
    const identity = new IdentityStack(app, 'Identity', {
      envName: 'dev',
      portalOrigins: [ORIGIN],
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const stack = new Stack(app, 'Management');
    const table = (id: string, key: string) =>
      new TableV2(stack, id, { partitionKey: { name: key, type: AttributeType.STRING } });
    new PlatformAdminBootstrap(stack, 'Bootstrap', {
      userPool: identity.userPool,
      memberships: table('Memberships', 'userId'),
      platformCounters: table('PlatformCounters', 'counter'),
      email: 'admin@example.com',
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({ [PLATFORM_ADMIN_BOOTSTRAP_ENV.email]: 'admin@example.com' }),
      },
    });
    template.hasResource('Custom::Trigger', {
      Properties: Match.objectLike({ InvocationType: 'RequestResponse' }),
      DependsOn: Match.arrayWith([
        Match.stringLikeRegexp('^Memberships'),
        Match.stringLikeRegexp('^PlatformCounters'),
      ]),
    });
  });
});

describe('resolveIdentitySettings', () => {
  it('accepts valid values and rejects invalid ones in one error', () => {
    const context: Record<string, unknown> = {
      initialPlatformAdminEmail: ' admin@example.com ',
      cognitoDomainPrefix: 'open-estate-dev',
    };
    expect(resolveIdentitySettings((key) => context[key])).toEqual({
      initialPlatformAdminEmail: 'admin@example.com',
      cognitoDomainPrefix: 'open-estate-dev',
    });
    expect(() =>
      resolveIdentitySettings(
        (key) => ({ initialPlatformAdminEmail: 'nope', cognitoDomainPrefix: 'my-cognito' })[key],
      ),
    ).toThrow(/initialPlatformAdminEmail[\s\S]*cognitoDomainPrefix/);
  });
});

describe('bootstrapPlatformAdmin', () => {
  it('creates the Plattform_Admin once, then skips', async () => {
    const memberships = new InMemoryMembershipStore();
    const platformCounters = new InMemoryPlatformCounterStore();
    const identity = new InMemoryIdentityDirectory();
    const deps = {
      memberships,
      platformCounters,
      identity,
      transactor: new InMemoryTransactor(),
      clock: () => 0,
    };
    const first = await bootstrapPlatformAdmin(deps, 'admin@example.com');
    expect(first).toEqual({ status: 'CREATED', userId: 'invited-1' });
    expect(await memberships.get('invited-1')).toMatchObject({ role: 'PLATFORM_ADMIN' });
    expect(await bootstrapPlatformAdmin(deps, 'admin@example.com')).toEqual({
      status: 'SKIPPED',
      platformAdmins: 1,
    });
    expect(identity.invited).toEqual(['admin@example.com']);
  });
});
