import * as path from 'node:path';
import { Aws, CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import {
  AccountRecovery,
  CfnManagedLoginBranding,
  FeaturePlan,
  ManagedLoginVersion,
  Mfa,
  OAuthScope,
  UserPool,
  UserPoolClient,
  UserPoolClientIdentityProvider,
  UserPoolDomain,
  type IUserPool,
} from 'aws-cdk-lib/aws-cognito';
import type { ITableV2 } from 'aws-cdk-lib/aws-dynamodb';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import type { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { InvocationType, Trigger } from 'aws-cdk-lib/triggers';
import { Construct } from 'constructs';
import { bundledFunction } from './api-stack';
import { PLATFORM_ADMIN_BOOTSTRAP_ENV } from './lambda/platform-admin-bootstrap';

// Identity_Provider of the Agentur_Portal (Req 1.3, 5.1; design: "Identität & Berechtigung"):
// Cognito holds only the identity (`sub`, e-mail); roles and agencies live in `Memberships`.
//
// Stack order: Frontend → Identity → Management. The app client needs the CloudFront origin of
// the FrontendStack for its callback URLs, so the IdentityStack references `FrontendStack.origin`
// directly. The reverse direction is impossible without a cycle, which is fine: like the
// Management_API URL, the client id reaches the SPA from a stack deployed after the
// FrontendStack. The SSM parameter `frontend-origin` is no alternative here: Cognito cannot read
// it at runtime, and a deploy-time `{{resolve:ssm:…}}` fails on the first deployment, when the
// FrontendStack has not written it yet.

const REPO_ROOT = path.resolve(__dirname, '../../..');
const INFRA_PACKAGE = path.join(REPO_ROOT, 'packages/infra');

/** OIDC redirect target of the portal (`/portal` routes); registered for every portal origin. */
export const PORTAL_CALLBACK_PATH = '/portal';
/** Target after Cognito logout (public search). */
export const PORTAL_LOGOUT_PATH = '/';

/** CDK context keys of the identity configuration. */
export const IDENTITY_CONTEXT_KEYS = {
  /** E-mail address of the first Plattform_Admin (Req 10.10), e.g. `-c initialPlatformAdminEmail=a@b.de`. */
  initialPlatformAdminEmail: 'initialPlatformAdminEmail',
  /** Globally unique per region; default {@link defaultCognitoDomainPrefix}. */
  cognitoDomainPrefix: 'cognitoDomainPrefix',
} as const;

export interface IdentitySettings {
  readonly initialPlatformAdminEmail?: string;
  readonly cognitoDomainPrefix?: string;
}

// Cognito: lowercase letters, digits, hyphens; no reserved words; at most 63 characters.
const DOMAIN_PREFIX_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DOMAIN_PREFIX_RESERVED = /aws|amazon|cognito/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Reads and validates {@link IDENTITY_CONTEXT_KEYS}; reports every invalid value in one error. */
export function resolveIdentitySettings(getContext: (key: string) => unknown): IdentitySettings {
  const errors: string[] = [];
  function pick(key: string, valid: (value: string) => boolean, expected: string) {
    const raw = getContext(key);
    if (raw === undefined) return undefined;
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (valid(value)) return value;
    errors.push(`"${key}": ${JSON.stringify(raw)} (expected ${expected})`);
    return undefined;
  }
  const email = pick(
    IDENTITY_CONTEXT_KEYS.initialPlatformAdminEmail,
    (value) => EMAIL_PATTERN.test(value),
    'an e-mail address',
  );
  const prefix = pick(
    IDENTITY_CONTEXT_KEYS.cognitoDomainPrefix,
    (value) => DOMAIN_PREFIX_PATTERN.test(value) && !DOMAIN_PREFIX_RESERVED.test(value),
    'lowercase letters, digits and hyphens without aws/amazon/cognito',
  );
  if (errors.length > 0) {
    throw new Error(`Invalid context value(s):\n  - ${errors.join('\n  - ')}`);
  }
  return {
    ...(email !== undefined && { initialPlatformAdminEmail: email }),
    ...(prefix !== undefined && { cognitoDomainPrefix: prefix }),
  };
}

/** `open-estate-<env>-<account id>`: deterministic and unique across accounts. */
export function defaultCognitoDomainPrefix(envName: string): string {
  return `open-estate-${envName}-${Aws.ACCOUNT_ID}`;
}

/**
 * Origins the portal's OIDC client calls from the browser, computed without a reference to the
 * IdentityStack (for the CSP of the FrontendStack, which deploys first): the Cognito domain of
 * `domainPrefix` (token endpoint; same URL as `UserPoolDomain.baseUrl()`) and the issuer host
 * (discovery document, JWKS). Pseudo parameters resolve in the stack that uses them.
 */
export function cognitoPortalOrigins(domainPrefix: string): string[] {
  return [
    `https://${domainPrefix}.auth.${Aws.REGION}.amazoncognito.com`,
    `https://cognito-idp.${Aws.REGION}.${Aws.URL_SUFFIX}`,
  ];
}

export interface IdentityStackProps extends StackProps {
  readonly envName: string;
  /**
   * Browser origins of the Agentur_Portal (`https://host[:port]`, no trailing slash): the
   * CloudFront origin of the FrontendStack plus additional origins, e.g. a custom domain or
   * `http://localhost:4200` (Cognito accepts plain http only for localhost).
   */
  readonly portalOrigins: readonly string[];
  /** Default {@link defaultCognitoDomainPrefix}. */
  readonly cognitoDomainPrefix?: string;
  /** `RETAIN` also enables deletion protection of the User Pool. */
  readonly removalPolicy: RemovalPolicy;
}

/**
 * Cognito User Pool without self sign-up (accounts only by invitation, Req 1.5) with e-mail as
 * username, Managed Login on a Cognito domain and the public portal app client
 * (Authorization Code + PKCE, refresh token rotation).
 */
export class IdentityStack extends Stack {
  readonly userPool: UserPool;
  readonly portalClient: UserPoolClient;
  readonly domain: UserPoolDomain;
  /** `https://<prefix>.auth.<region>.amazoncognito.com` (Managed Login, OAuth endpoints). */
  readonly domainUrl: string;
  /** OIDC issuer (`https://cognito-idp.<region>.amazonaws.com/<pool id>`). */
  readonly issuerUrl: string;

  constructor(scope: Construct, id: string, props: IdentityStackProps) {
    super(scope, id, props);
    if (props.portalOrigins.length === 0) throw new Error('IdentityStack needs a portal origin');

    this.userPool = new UserPool(this, 'UserPool', {
      userPoolName: `${id}-users`,
      selfSignUpEnabled: false,
      // Username = e-mail address (`CognitoIdentityDirectory` creates users with it).
      signInAliases: { email: true },
      signInCaseSensitive: false,
      autoVerify: { email: true },
      standardAttributes: {
        email: { required: true, mutable: true },
        fullname: { required: false, mutable: true },
      },
      accountRecovery: AccountRecovery.EMAIL_ONLY,
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
        tempPasswordValidity: Duration.days(7),
      },
      mfa: Mfa.OPTIONAL,
      mfaSecondFactor: { otp: true, sms: false },
      // Managed Login needs Essentials (Lite only offers the classic Hosted UI).
      featurePlan: FeaturePlan.ESSENTIALS,
      deletionProtection: props.removalPolicy !== RemovalPolicy.DESTROY,
      removalPolicy: props.removalPolicy,
    });

    this.domain = this.userPool.addDomain('Domain', {
      cognitoDomain: {
        domainPrefix: props.cognitoDomainPrefix ?? defaultCognitoDomainPrefix(props.envName),
      },
      managedLoginVersion: ManagedLoginVersion.NEWER_MANAGED_LOGIN,
    });

    // Public SPA client: no secret, Code flow only (Cognito enforces PKCE when the request
    // carries a `code_challenge`; the OIDC client always sends one). Rotation issues a new
    // refresh token on every refresh; the old one stays valid for the grace period (parallel
    // tabs, retries). Without `aws.cognito.signin.user.admin` the tokens cannot change user
    // attributes, so the e-mail address stays in sync with `Memberships`.
    this.portalClient = this.userPool.addClient('PortalClient', {
      userPoolClientName: 'portal',
      generateSecret: false,
      // Rotation excludes ALLOW_REFRESH_TOKEN_AUTH; SRP keeps the flow list non-empty, otherwise
      // Cognito applies its default flows.
      authFlows: { userSrp: true },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [OAuthScope.OPENID, OAuthScope.EMAIL, OAuthScope.PROFILE],
        callbackUrls: props.portalOrigins.map((origin) => `${origin}${PORTAL_CALLBACK_PATH}`),
        logoutUrls: props.portalOrigins.map((origin) => `${origin}${PORTAL_LOGOUT_PATH}`),
      },
      supportedIdentityProviders: [UserPoolClientIdentityProvider.COGNITO],
      preventUserExistenceErrors: true,
      enableTokenRevocation: true,
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(1),
      refreshTokenRotationGracePeriod: Duration.seconds(10),
    });

    // Managed Login shows a page only for clients with a branding; Cognito defaults suffice.
    new CfnManagedLoginBranding(this, 'PortalLoginBranding', {
      userPoolId: this.userPool.userPoolId,
      clientId: this.portalClient.userPoolClientId,
      useCognitoProvidedValues: true,
    });

    this.domainUrl = this.domain.baseUrl();
    this.issuerUrl = this.userPool.userPoolProviderUrl;

    new CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId });
    new CfnOutput(this, 'PortalClientId', { value: this.portalClient.userPoolClientId });
    new CfnOutput(this, 'CognitoDomainUrl', { value: this.domainUrl });
  }
}

export interface PlatformAdminBootstrapProps {
  readonly userPool: IUserPool;
  readonly memberships: ITableV2;
  readonly platformCounters: ITableV2;
  /** {@link IdentitySettings.initialPlatformAdminEmail}. */
  readonly email: string;
  readonly removalPolicy: RemovalPolicy;
}

/**
 * CDK Trigger creating the first Plattform_Admin (Req 10.10, `bootstrapPlatformAdmin`). It runs
 * synchronously after the tables and on every change of the function (code or e-mail address);
 * a failure fails the deployment. Lives in the stack owning `Memberships`/`PlatformCounters`
 * (ManagementStack), which depends on the IdentityStack anyway.
 */
export class PlatformAdminBootstrap extends Construct {
  readonly function: NodejsFunction;
  readonly trigger: Trigger;

  constructor(scope: Construct, id: string, props: PlatformAdminBootstrapProps) {
    super(scope, id);
    const { userPool, memberships, platformCounters } = props;

    this.function = bundledFunction(this, 'Function', {
      description: 'Creates the first Plattform_Admin while none exists (Req 10.10)',
      packageDir: INFRA_PACKAGE,
      entry: 'src/lambda/platform-admin-bootstrap.ts',
      memorySize: 256,
      timeout: Duration.seconds(30),
      removalPolicy: props.removalPolicy,
      retryAttempts: 0,
    });
    const env: Record<keyof typeof PLATFORM_ADMIN_BOOTSTRAP_ENV, string> = {
      userPoolId: userPool.userPoolId,
      membershipsTable: memberships.tableName,
      platformCountersTable: platformCounters.tableName,
      email: props.email,
    };
    for (const [key, name] of Object.entries(PLATFORM_ADMIN_BOOTSTRAP_ENV)) {
      this.function.addEnvironment(name, env[key as keyof typeof env]);
    }

    // `ListUsers` (existing account) and `AdminCreateUser` (invitation); the transaction puts
    // the membership and updates the counter.
    this.function.addToRolePolicy(
      new PolicyStatement({
        actions: ['cognito-idp:ListUsers', 'cognito-idp:AdminCreateUser'],
        resources: [userPool.userPoolArn],
      }),
    );
    this.function.addToRolePolicy(
      new PolicyStatement({ actions: ['dynamodb:PutItem'], resources: [memberships.tableArn] }),
    );
    this.function.addToRolePolicy(
      new PolicyStatement({
        actions: ['dynamodb:GetItem', 'dynamodb:UpdateItem'],
        resources: [platformCounters.tableArn],
      }),
    );

    this.trigger = new Trigger(this, 'Trigger', {
      handler: this.function,
      invocationType: InvocationType.REQUEST_RESPONSE,
      executeOnHandlerChange: true,
      executeAfter: [memberships, platformCounters],
      timeout: Duration.minutes(1),
    });
  }
}
