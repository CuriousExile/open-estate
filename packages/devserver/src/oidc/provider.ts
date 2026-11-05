import { randomBytes, randomUUID } from 'node:crypto';
import type { AccessTokenVerifier } from '@open-estate/core';
import type { Role } from '@open-estate/shared';
import { generateSigningKey, signJwt, verifyJwt, type SigningKey } from './jwt';
import { isValidCodeChallenge, verifyPkce } from './pkce';

// DEV ONLY — INSECURE. A minimal OpenID Connect provider (Authorization Code + PKCE, refresh
// tokens) that stands in for the Cognito User Pool when the platform runs locally. There are no
// passwords: the login page lets anybody pick one of the demo users. Tokens are RS256-signed with
// a key pair generated per process; their claims mimic Cognito (`token_use`, `client_id`), so the
// Management_API's Authenticator works unchanged with the verifier of this provider. Redirect and
// logout targets are restricted to loopback URLs. Never expose this provider beyond 127.0.0.1.

/** A user the login page offers; `userId` is the `sub` claim (= `Memberships` key). */
export interface DemoUser {
  userId: string;
  email: string;
  displayName: string;
  role: Role;
  agencyName?: string;
  /** Short explanation shown on the login page. */
  hint?: string;
}

export interface OidcProviderOptions {
  /** Absolute issuer URL, e.g. `http://127.0.0.1:4310/oidc`; also the base of all endpoints. */
  issuer: string;
  /** The only accepted client (the portal's public app client). */
  clientId: string;
  /** Users offered on the login page; read per request, so new members appear immediately. */
  users(): Promise<readonly DemoUser[]>;
  clock?: () => number;
  /** Lifetime of id and access tokens; default 3600 s (Cognito default). */
  tokenTtlSeconds?: number;
  /** Lifetime of an authorization code; default 120 s. */
  codeTtlSeconds?: number;
  signingKey?: SigningKey;
}

export interface OidcRequest {
  method: string;
  /** Path below the issuer, e.g. `/token`. */
  path: string;
  query: URLSearchParams;
  /** Parsed `application/x-www-form-urlencoded` body of POST requests. */
  form?: URLSearchParams;
}

export interface OidcResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

interface AuthorizeParams {
  clientId: string;
  redirectUri: string;
  scope: string;
  state?: string;
  nonce?: string;
  codeChallenge: string;
}

interface CodeGrant extends AuthorizeParams {
  userId: string;
  expiresAt: number;
  authTime: number;
}

interface RefreshGrant {
  userId: string;
  clientId: string;
  scope: string;
  authTime: number;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Only http(s) URLs on a loopback host are accepted as redirect and logout targets. */
export function isLoopbackUrl(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      LOOPBACK_HOSTS.has(url.hostname) &&
      url.username === '' &&
      url.password === ''
    );
  } catch {
    return false;
  }
}

const NO_STORE = { 'Cache-Control': 'no-store', Pragma: 'no-cache' };

const json = (status: number, body: unknown): OidcResponse => ({
  status,
  headers: { 'Content-Type': 'application/json', ...NO_STORE },
  body: JSON.stringify(body),
});

const oauthError = (status: number, error: string, description: string): OidcResponse =>
  json(status, { error, error_description: description });

const redirect = (location: string): OidcResponse => ({
  status: 302,
  headers: { Location: location, ...NO_STORE },
  body: '',
});

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

const html = (
  status: number,
  title: string,
  content: string,
  formTarget?: string,
): OidcResponse => ({
  status,
  headers: {
    'Content-Type': 'text/html; charset=utf-8',
    // `form-action` also governs the redirect after the POST, so the client origin is allowed.
    'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'${
      formTarget === undefined ? '' : ` ${formTarget}`
    }`,
    ...NO_STORE,
  },
  body: `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
body{font-family:system-ui,sans-serif;max-width:44rem;margin:2rem auto;padding:0 1rem;color:#1f2933}
.warn{background:#fff3cd;border:1px solid #e0b100;padding:.75rem 1rem;border-radius:.5rem}
form{margin:.75rem 0}button{width:100%;text-align:left;padding:.75rem 1rem;border:1px solid #cbd2d9;
border-radius:.5rem;background:#fff;cursor:pointer;font-size:1rem}button:hover{background:#f0f4f8}
small{color:#52606d}code{background:#f0f4f8;padding:0 .25rem}
</style></head><body>
<p class="warn"><strong>DEV ONLY — insecure local login.</strong> No password is checked; anyone
who can reach this server can sign in as any demo user. Never expose it beyond 127.0.0.1.</p>
${content}
</body></html>`,
});

const ROLE_LABEL: Readonly<Record<Role, string>> = {
  PLATFORM_ADMIN: 'Platform admin',
  AGENCY_ADMIN: 'Agency admin',
  AGENCY_MEMBER: 'Agency member',
};

/** The local OIDC provider; see the module comment. */
export class DevOidcProvider {
  readonly issuer: string;
  readonly clientId: string;
  private readonly key: SigningKey;
  private readonly users: () => Promise<readonly DemoUser[]>;
  private readonly clock: () => number;
  private readonly tokenTtlSeconds: number;
  private readonly codeTtlMs: number;
  private readonly codes = new Map<string, CodeGrant>();
  private readonly refreshGrants = new Map<string, RefreshGrant>();

  constructor(options: OidcProviderOptions) {
    this.issuer = options.issuer.replace(/\/+$/, '');
    this.clientId = options.clientId;
    this.key = options.signingKey ?? generateSigningKey();
    this.users = options.users;
    this.clock = options.clock ?? Date.now;
    this.tokenTtlSeconds = options.tokenTtlSeconds ?? 3600;
    this.codeTtlMs = (options.codeTtlSeconds ?? 120) * 1000;
  }

  /** OIDC discovery document (`/.well-known/openid-configuration`). */
  discovery(): Record<string, unknown> {
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/authorize`,
      token_endpoint: `${this.issuer}/token`,
      jwks_uri: `${this.issuer}/.well-known/jwks.json`,
      // Like Cognito: no `end_session_endpoint`; the portal calls `/logout` of the domain.
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      code_challenge_methods_supported: ['S256'],
      scopes_supported: ['openid', 'email', 'profile'],
      token_endpoint_auth_methods_supported: ['none'],
      claims_supported: ['sub', 'email', 'email_verified', 'name', 'cognito:username'],
    };
  }

  jwks(): { keys: SigningKey['publicJwk'][] } {
    return { keys: [this.key.publicJwk] };
  }

  /**
   * Verifier for the Management_API's `CachingAuthenticator`: signature, `exp`, issuer,
   * `token_use: access` and `client_id` — the checks `aws-jwt-verify` does for Cognito.
   */
  accessTokenVerifier(): AccessTokenVerifier {
    return {
      verify: async (jwt) => {
        const claims = verifyJwt(jwt, [this.key.publicJwk], this.clock());
        if (claims === null) return null;
        const valid =
          claims['iss'] === this.issuer &&
          claims['token_use'] === 'access' &&
          claims['client_id'] === this.clientId &&
          typeof claims['sub'] === 'string';
        return valid ? (claims['sub'] as string) : null;
      },
    };
  }

  async handle(request: OidcRequest): Promise<OidcResponse> {
    const method = request.method.toUpperCase();
    const route = `${method} ${request.path.replace(/\/+$/, '') || '/'}`;
    switch (route) {
      case 'GET /.well-known/openid-configuration':
        return json(200, this.discovery());
      case 'GET /.well-known/jwks.json':
        return json(200, this.jwks());
      case 'GET /authorize':
        return this.loginPage(request.query);
      case 'POST /authorize':
        return this.authorize(request.form ?? new URLSearchParams());
      case 'POST /token':
        return this.token(request.form ?? new URLSearchParams());
      case 'GET /logout':
        return this.logout(request.query);
      default:
        return oauthError(404, 'not_found', `No OIDC endpoint ${route}`);
    }
  }

  /**
   * Validates an authorization request. Without a valid client and loopback redirect URI the
   * error is shown as a page (never redirected, RFC 6749 §4.1.2.1); other errors are redirected.
   */
  private parseAuthorize(
    params: URLSearchParams,
  ): { ok: true; value: AuthorizeParams } | { ok: false; response: OidcResponse } {
    const clientId = params.get('client_id') ?? '';
    const redirectUri = params.get('redirect_uri') ?? '';
    if (clientId !== this.clientId || !isLoopbackUrl(redirectUri)) {
      return {
        ok: false,
        response: html(
          400,
          'Invalid login request',
          '<h1>Invalid login request</h1><p>Unknown <code>client_id</code> or a ' +
            '<code>redirect_uri</code> that is not a loopback URL.</p>',
        ),
      };
    }
    const state = params.get('state') ?? undefined;
    const fail = (error: string, description: string) => {
      const target = new URL(redirectUri);
      target.searchParams.set('error', error);
      target.searchParams.set('error_description', description);
      if (state !== undefined) target.searchParams.set('state', state);
      return { ok: false as const, response: redirect(target.toString()) };
    };
    if (params.get('response_type') !== 'code') {
      return fail('unsupported_response_type', 'Only response_type=code is supported');
    }
    const codeChallenge = params.get('code_challenge') ?? '';
    if (!isValidCodeChallenge(codeChallenge, params.get('code_challenge_method') ?? undefined)) {
      return fail('invalid_request', 'PKCE with code_challenge_method=S256 is required');
    }
    const scope = params.get('scope') ?? '';
    if (!scope.split(' ').includes('openid')) {
      return fail('invalid_scope', 'The openid scope is required');
    }
    const nonce = params.get('nonce') ?? undefined;
    return {
      ok: true,
      value: {
        clientId,
        redirectUri,
        scope,
        codeChallenge,
        ...(state !== undefined && { state }),
        ...(nonce !== undefined && { nonce }),
      },
    };
  }

  private async loginPage(query: URLSearchParams): Promise<OidcResponse> {
    const parsed = this.parseAuthorize(query);
    if (!parsed.ok) return parsed.response;
    const hidden = [...query.entries()]
      .filter(([name]) => name !== 'user_id')
      .map(
        ([name, value]) =>
          `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`,
      )
      .join('');
    const users = await this.users();
    const buttons = users
      .map((user) => {
        const agency = user.agencyName === undefined ? '' : ` · ${escapeHtml(user.agencyName)}`;
        const hint = user.hint === undefined ? '' : `<br><small>${escapeHtml(user.hint)}</small>`;
        return (
          `<form method="post" action="${escapeHtml(`${this.issuer}/authorize`)}">${hidden}` +
          `<input type="hidden" name="user_id" value="${escapeHtml(user.userId)}">` +
          `<button type="submit"><strong>${escapeHtml(user.displayName)}</strong> ` +
          `&lt;${escapeHtml(user.email)}&gt;<br><small>${ROLE_LABEL[user.role]}${agency}</small>` +
          `${hint}</button></form>`
        );
      })
      .join('\n');
    return html(
      200,
      'OpenEstate local login',
      `<h1>OpenEstate — local demo login</h1><p>Choose a demo user:</p>${buttons}`,
      new URL(parsed.value.redirectUri).origin,
    );
  }

  private async authorize(form: URLSearchParams): Promise<OidcResponse> {
    const parsed = this.parseAuthorize(form);
    if (!parsed.ok) return parsed.response;
    const params = parsed.value;
    const userId = form.get('user_id') ?? '';
    const users = await this.users();
    if (!users.some((user) => user.userId === userId)) {
      return html(400, 'Unknown user', '<h1>Unknown demo user</h1>');
    }
    const now = this.clock();
    const code = randomBytes(32).toString('base64url');
    this.codes.set(code, {
      ...params,
      userId,
      expiresAt: now + this.codeTtlMs,
      authTime: Math.floor(now / 1000),
    });
    const target = new URL(params.redirectUri);
    target.searchParams.set('code', code);
    if (params.state !== undefined) target.searchParams.set('state', params.state);
    return redirect(target.toString());
  }

  private async token(form: URLSearchParams): Promise<OidcResponse> {
    if (form.get('client_id') !== this.clientId) {
      return oauthError(401, 'invalid_client', 'Unknown client_id');
    }
    switch (form.get('grant_type')) {
      case 'authorization_code':
        return this.exchangeCode(form);
      case 'refresh_token':
        return this.refresh(form);
      default:
        return oauthError(400, 'unsupported_grant_type', 'Unsupported grant_type');
    }
  }

  private async exchangeCode(form: URLSearchParams): Promise<OidcResponse> {
    const code = form.get('code') ?? '';
    const grant = this.codes.get(code);
    // Single use: a code is consumed by its first exchange attempt, successful or not.
    this.codes.delete(code);
    const invalid = (description: string) => oauthError(400, 'invalid_grant', description);
    if (grant === undefined || grant.expiresAt <= this.clock()) {
      return invalid('Unknown, used or expired code');
    }
    if (
      grant.clientId !== form.get('client_id') ||
      grant.redirectUri !== form.get('redirect_uri')
    ) {
      return invalid('client_id or redirect_uri does not match the authorization request');
    }
    if (!verifyPkce(form.get('code_verifier') ?? undefined, grant.codeChallenge)) {
      return invalid('PKCE verification failed');
    }
    return this.issue(grant.userId, grant.scope, grant.authTime, grant.nonce);
  }

  private async refresh(form: URLSearchParams): Promise<OidcResponse> {
    const presented = form.get('refresh_token') ?? '';
    const grant = this.refreshGrants.get(presented);
    if (grant === undefined || grant.clientId !== form.get('client_id')) {
      return oauthError(400, 'invalid_grant', 'Unknown or revoked refresh token');
    }
    // Rotation: the presented refresh token is replaced by the one in the response.
    this.refreshGrants.delete(presented);
    return this.issue(grant.userId, grant.scope, grant.authTime);
  }

  private async issue(
    userId: string,
    scope: string,
    authTime: number,
    nonce?: string,
  ): Promise<OidcResponse> {
    const user = (await this.users()).find((candidate) => candidate.userId === userId);
    if (user === undefined) return oauthError(400, 'invalid_grant', 'User no longer exists');
    const iat = Math.floor(this.clock() / 1000);
    const exp = iat + this.tokenTtlSeconds;
    const common = { iss: this.issuer, sub: user.userId, iat, exp, auth_time: authTime };
    const accessJwt = signJwt(
      {
        ...common,
        token_use: 'access',
        client_id: this.clientId,
        scope,
        username: user.email,
        jti: randomUUID(),
      },
      this.key,
    );
    const idJwt = signJwt(
      {
        ...common,
        aud: this.clientId,
        token_use: 'id',
        email: user.email,
        email_verified: true,
        name: user.displayName,
        'cognito:username': user.email,
        ...(nonce !== undefined && { nonce }),
      },
      this.key,
    );
    const refreshValue = randomBytes(32).toString('base64url');
    this.refreshGrants.set(refreshValue, { userId, clientId: this.clientId, scope, authTime });
    return json(200, {
      access_token: accessJwt,
      id_token: idJwt,
      refresh_token: refreshValue,
      token_type: 'Bearer',
      expires_in: this.tokenTtlSeconds,
    });
  }

  private logout(query: URLSearchParams): OidcResponse {
    const target = query.get('logout_uri');
    if (query.get('client_id') !== this.clientId || !isLoopbackUrl(target)) {
      return html(400, 'Invalid logout', '<h1>Invalid logout request</h1>');
    }
    // Stateless login page: there is no provider session to end.
    return redirect(target as string);
  }
}
