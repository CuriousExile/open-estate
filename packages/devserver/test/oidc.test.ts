import { decodeJwt, generateSigningKey, signJwt, verifyJwt } from '../src/oidc/jwt';
import { isValidCodeChallenge, s256Challenge, verifyPkce } from '../src/oidc/pkce';
import { DevOidcProvider, isLoopbackUrl, type DemoUser } from '../src/oidc/provider';

const ISSUER = 'http://127.0.0.1:4310/oidc';
const CLIENT = 'local-portal-client';
const REDIRECT = 'http://127.0.0.1:4200/portal';
const T0 = Date.parse('2026-11-05T10:00:00.000Z');

const USERS: DemoUser[] = [
  {
    userId: 'user-anna',
    email: 'anna@example.org',
    displayName: 'Anna <Admin>',
    role: 'AGENCY_ADMIN',
    agencyName: 'Nordlicht',
  },
  {
    userId: 'user-paula',
    email: 'paula@example.org',
    displayName: 'Paula',
    role: 'PLATFORM_ADMIN',
  },
];

// RFC 7636, Appendix B.
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

const key = generateSigningKey();

function setup(start = T0) {
  let now = start;
  const provider = new DevOidcProvider({
    issuer: `${ISSUER}/`,
    clientId: CLIENT,
    users: async () => USERS,
    clock: () => now,
    signingKey: key,
  });
  return { provider, advance: (ms: number) => (now += ms) };
}

const authorizeParams = (overrides: Record<string, string> = {}) =>
  new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT,
    redirect_uri: REDIRECT,
    scope: 'openid email profile',
    state: 'state-123',
    nonce: 'nonce-456',
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    ...overrides,
  });

async function login(provider: DevOidcProvider, userId = 'user-anna'): Promise<string> {
  const form = authorizeParams();
  form.set('user_id', userId);
  const response = await provider.handle({
    method: 'POST',
    path: '/authorize',
    query: new URLSearchParams(),
    form,
  });
  expect(response.status).toBe(302);
  const location = new URL(response.headers['Location'] ?? '');
  expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
  expect(location.searchParams.get('state')).toBe('state-123');
  return location.searchParams.get('code') ?? '';
}

const tokenRequest = (provider: DevOidcProvider, fields: Record<string, string>) =>
  provider.handle({
    method: 'POST',
    path: '/token',
    query: new URLSearchParams(),
    form: new URLSearchParams({ client_id: CLIENT, ...fields }),
  });

const exchange = (provider: DevOidcProvider, code: string, verifier = VERIFIER) =>
  tokenRequest(provider, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT,
    code_verifier: verifier,
  });

interface Tokens {
  access_token: string;
  id_token: string;
  refresh_token: string;
  expires_in: number;
}

describe('RS256 JWT', () => {
  it('verifies its own signature and returns the claims', () => {
    const jwt = signJwt({ sub: 'u1', exp: T0 / 1000 + 60 }, key);
    expect(verifyJwt(jwt, [key.publicJwk], T0)).toEqual({ sub: 'u1', exp: T0 / 1000 + 60 });
    expect(decodeJwt(jwt)?.header).toEqual({ alg: 'RS256', typ: 'JWT', kid: key.kid });
  });

  it('rejects tampered, expired, foreign-key and malformed tokens', () => {
    const jwt = signJwt({ sub: 'u1', exp: T0 / 1000 + 60 }, key);
    const [header, , signature] = jwt.split('.');
    const forged = Buffer.from(JSON.stringify({ sub: 'admin', exp: T0 / 1000 + 60 })).toString(
      'base64url',
    );
    expect(verifyJwt(`${header}.${forged}.${signature}`, [key.publicJwk], T0)).toBeNull();
    expect(verifyJwt(jwt, [key.publicJwk], T0 + 60_000)).toBeNull();
    expect(verifyJwt(jwt, [generateSigningKey().publicJwk], T0)).toBeNull();
    expect(verifyJwt('not.a.jwt', [key.publicJwk], T0)).toBeNull();
    expect(verifyJwt(signJwt({ sub: 'u1' }, key), [key.publicJwk], T0)).toBeNull();
  });
});

describe('PKCE', () => {
  it('computes the S256 challenge of RFC 7636 Appendix B', () => {
    expect(s256Challenge(VERIFIER)).toBe(CHALLENGE);
    expect(verifyPkce(VERIFIER, CHALLENGE)).toBe(true);
  });

  it('rejects wrong, missing and malformed verifiers and non-S256 methods', () => {
    expect(verifyPkce(`${VERIFIER}x`, CHALLENGE)).toBe(false);
    expect(verifyPkce(undefined, CHALLENGE)).toBe(false);
    expect(verifyPkce('short', s256Challenge('short'))).toBe(false);
    expect(isValidCodeChallenge(CHALLENGE, 'S256')).toBe(true);
    expect(isValidCodeChallenge(VERIFIER, 'plain')).toBe(false);
    expect(isValidCodeChallenge('too-short', 'S256')).toBe(false);
  });
});

describe('isLoopbackUrl', () => {
  it.each([
    ['http://127.0.0.1:4200/portal', true],
    ['http://localhost:4200/', true],
    ['http://[::1]:4200/', true],
    ['https://example.org/portal', false],
    ['http://127.0.0.1.example.org/', false],
    ['http://user:pw@localhost/', false],
    ['javascript:alert(1)', false],
    ['not a url', false],
  ])('%s → %s', (url, expected) => {
    expect(isLoopbackUrl(url)).toBe(expected);
  });
});

describe('DevOidcProvider', () => {
  it('publishes discovery document and JWKS under the issuer', async () => {
    const { provider } = setup();
    const discovery = await provider.handle({
      method: 'GET',
      path: '/.well-known/openid-configuration',
      query: new URLSearchParams(),
    });
    expect(JSON.parse(discovery.body)).toMatchObject({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      jwks_uri: `${ISSUER}/.well-known/jwks.json`,
      code_challenge_methods_supported: ['S256'],
    });
    const jwks = await provider.handle({
      method: 'GET',
      path: '/.well-known/jwks.json',
      query: new URLSearchParams(),
    });
    expect(JSON.parse(jwks.body)).toEqual({ keys: [key.publicJwk] });
  });

  it('shows a login page listing the demo users with escaped names', async () => {
    const { provider } = setup();
    const page = await provider.handle({
      method: 'GET',
      path: '/authorize',
      query: authorizeParams(),
    });
    expect(page.status).toBe(200);
    expect(page.body).toContain('DEV ONLY');
    expect(page.body).toContain('Anna &#60;Admin&#62;');
    expect(page.body).toContain('value="user-paula"');
    expect(page.body).not.toContain('<Admin>');
    expect(page.headers['Content-Security-Policy']).toContain(
      "form-action 'self' http://127.0.0.1:4200",
    );
  });

  it('never redirects to unknown clients or non-loopback URIs', async () => {
    const { provider } = setup();
    for (const overrides of [
      { client_id: 'other' },
      { redirect_uri: 'https://attacker.example.org/cb' },
    ]) {
      const response = await provider.handle({
        method: 'GET',
        path: '/authorize',
        query: authorizeParams(overrides),
      });
      expect(response.status).toBe(400);
      expect(response.headers['Location']).toBeUndefined();
    }
  });

  it('redirects protocol errors (missing PKCE, wrong response type) back with state', async () => {
    const { provider } = setup();
    const noPkce = authorizeParams();
    noPkce.delete('code_challenge');
    const cases: [URLSearchParams, string][] = [
      [noPkce, 'invalid_request'],
      [authorizeParams({ response_type: 'token' }), 'unsupported_response_type'],
      [authorizeParams({ scope: 'email' }), 'invalid_scope'],
    ];
    for (const [query, error] of cases) {
      const response = await provider.handle({ method: 'GET', path: '/authorize', query });
      const location = new URL(response.headers['Location'] ?? '');
      expect(location.searchParams.get('error')).toBe(error);
      expect(location.searchParams.get('state')).toBe('state-123');
    }
  });

  it('issues Cognito-like tokens for a code with a matching PKCE verifier', async () => {
    const { provider } = setup();
    const response = await exchange(provider, await login(provider));
    expect(response.status).toBe(200);
    expect(response.headers['Cache-Control']).toBe('no-store');
    const tokens = JSON.parse(response.body) as Tokens;
    expect(tokens.expires_in).toBe(3600);

    const id = verifyJwt(tokens.id_token, [key.publicJwk], T0);
    expect(id).toMatchObject({
      iss: ISSUER,
      sub: 'user-anna',
      aud: CLIENT,
      nonce: 'nonce-456',
      email: 'anna@example.org',
      token_use: 'id',
      iat: T0 / 1000,
      exp: T0 / 1000 + 3600,
    });
    const access = verifyJwt(tokens.access_token, [key.publicJwk], T0);
    expect(access).toMatchObject({ token_use: 'access', client_id: CLIENT, sub: 'user-anna' });
    await expect(provider.accessTokenVerifier().verify(tokens.access_token)).resolves.toBe(
      'user-anna',
    );
  });

  it('rejects a wrong verifier and consumes the code on the first attempt', async () => {
    const { provider } = setup();
    const code = await login(provider);
    const wrong = await exchange(provider, code, 'a'.repeat(43));
    expect(wrong.status).toBe(400);
    expect(JSON.parse(wrong.body)).toMatchObject({ error: 'invalid_grant' });
    expect((await exchange(provider, code)).status).toBe(400);
  });

  it('rejects expired codes, reused codes and mismatching redirect URIs', async () => {
    const { provider, advance } = setup();
    const expired = await login(provider);
    advance(121_000);
    expect((await exchange(provider, expired)).status).toBe(400);

    const code = await login(provider);
    expect((await exchange(provider, code)).status).toBe(200);
    expect((await exchange(provider, code)).status).toBe(400);

    const other = await login(provider);
    const mismatch = await tokenRequest(provider, {
      grant_type: 'authorization_code',
      code: other,
      redirect_uri: 'http://127.0.0.1:4200/elsewhere',
      code_verifier: VERIFIER,
    });
    expect(mismatch.status).toBe(400);
  });

  it('rotates refresh tokens and keeps sub and auth_time', async () => {
    const { provider, advance } = setup();
    const first = JSON.parse((await exchange(provider, await login(provider))).body) as Tokens;
    advance(600_000);
    const refreshed = await tokenRequest(provider, {
      grant_type: 'refresh_token',
      refresh_token: first.refresh_token,
    });
    expect(refreshed.status).toBe(200);
    const second = JSON.parse(refreshed.body) as Tokens;
    expect(second.refresh_token).not.toBe(first.refresh_token);
    const before = decodeJwt(first.id_token)?.claims;
    const after = decodeJwt(second.id_token)?.claims;
    expect(after?.['sub']).toBe(before?.['sub']);
    expect(after?.['auth_time']).toBe(before?.['auth_time']);
    expect(after?.['nonce']).toBeUndefined();
    const reuse = await tokenRequest(provider, {
      grant_type: 'refresh_token',
      refresh_token: first.refresh_token,
    });
    expect(reuse.status).toBe(400);
  });

  it('rejects unknown clients and grant types at the token endpoint', async () => {
    const { provider } = setup();
    const response = await provider.handle({
      method: 'POST',
      path: '/token',
      query: new URLSearchParams(),
      form: new URLSearchParams({ client_id: 'other', grant_type: 'authorization_code' }),
    });
    expect(response.status).toBe(401);
    expect((await tokenRequest(provider, { grant_type: 'password' })).status).toBe(400);
  });

  it('verifier rejects id tokens, foreign issuers, other clients and expired tokens', async () => {
    const { provider } = setup();
    const verifier = provider.accessTokenVerifier();
    const tokens = JSON.parse((await exchange(provider, await login(provider))).body) as Tokens;
    await expect(verifier.verify(tokens.id_token)).resolves.toBeNull();
    const exp = T0 / 1000 + 60;
    const base = { sub: 'user-anna', token_use: 'access', client_id: CLIENT, exp };
    await expect(
      verifier.verify(signJwt({ ...base, iss: 'http://evil' }, key)),
    ).resolves.toBeNull();
    await expect(
      verifier.verify(signJwt({ ...base, iss: ISSUER, client_id: 'x' }, key)),
    ).resolves.toBeNull();
    await expect(verifier.verify(signJwt({ ...base, iss: ISSUER }, key))).resolves.toBe(
      'user-anna',
    );
    const other = setup(T0 + 120_000).provider.accessTokenVerifier();
    await expect(other.verify(signJwt({ ...base, iss: ISSUER }, key))).resolves.toBeNull();
  });

  it('redirects logout only to loopback URIs of the client', async () => {
    const { provider } = setup();
    const ok = await provider.handle({
      method: 'GET',
      path: '/logout',
      query: new URLSearchParams({ client_id: CLIENT, logout_uri: 'http://127.0.0.1:4200/' }),
    });
    expect(ok.status).toBe(302);
    expect(ok.headers['Location']).toBe('http://127.0.0.1:4200/');
    const bad = await provider.handle({
      method: 'GET',
      path: '/logout',
      query: new URLSearchParams({ client_id: CLIENT, logout_uri: 'https://example.org/' }),
    });
    expect(bad.status).toBe(400);
  });
});
