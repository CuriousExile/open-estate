import {
  buildOidcConfig,
  cognitoLogoutUrl,
  decideAuth,
  isAuthCallback,
  isManagementApiUrl,
  rememberReturnUrl,
  resolvePortalConfig,
  sanitizeReturnUrl,
  takeReturnUrl,
  RETURN_URL_KEY,
  type KeyValueStorage,
} from '../src/app/auth/portal-auth-model';

const PORTAL = {
  issuer: 'https://cognito-idp.example.org/pool_1/',
  cognitoDomainUrl: 'https://auth.example.org/',
  clientId: 'client-1',
  managementApiUrl: 'https://manage.example.org/v1',
};
const ORIGIN = 'https://estate.example.org';

function storage(): KeyValueStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
}

describe('resolvePortalConfig', () => {
  it('accepts a valid portal block', () => {
    const state = resolvePortalConfig({
      status: 'loaded',
      value: { apiBaseUrl: '/api', portal: PORTAL },
    });
    expect(state).toEqual({ ok: true, config: PORTAL });
  });

  it('reports a missing block or an unavailable runtime config as missing', () => {
    expect(resolvePortalConfig({ status: 'loaded', value: { apiBaseUrl: '/api' } })).toEqual({
      ok: false,
      reason: 'missing',
    });
    expect(resolvePortalConfig({ status: 'failed', error: 'x' })).toEqual({
      ok: false,
      reason: 'missing',
    });
    expect(resolvePortalConfig(undefined)).toEqual({ ok: false, reason: 'missing' });
  });

  it('reports an invalid block with the failing fields', () => {
    const state = resolvePortalConfig({
      status: 'loaded',
      value: { apiBaseUrl: '/api', portal: { ...PORTAL, issuer: 'not a url', clientId: '' } },
    });
    expect(state.ok).toBe(false);
    expect(!state.ok && state.reason).toBe('invalid');
    expect(!state.ok && state.detail).toMatch(/issuer/);
    expect(!state.ok && state.detail).toMatch(/clientId/);
  });
});

describe('buildOidcConfig', () => {
  it('uses Code + PKCE with refresh tokens and the IdentityStack callback/logout paths', () => {
    const config = buildOidcConfig(PORTAL, `${ORIGIN}/`);
    expect(config).toMatchObject({
      authority: 'https://cognito-idp.example.org/pool_1',
      clientId: 'client-1',
      responseType: 'code',
      redirectUrl: `${ORIGIN}/portal`,
      postLogoutRedirectUri: `${ORIGIN}/`,
      scope: 'openid email profile',
      useRefreshToken: true,
      silentRenew: true,
      secureRoutes: [],
    });
  });

  it('leaves the post-login and failure navigation to the auth guard', () => {
    // The library would otherwise navigate to `postLoginRoute` ('/') after the code callback and
    // cancel the guard's redirect to the remembered portal route.
    expect(buildOidcConfig(PORTAL, ORIGIN).triggerAuthorizationResultEvent).toBe(true);
  });
});

describe('cognitoLogoutUrl', () => {
  it('points to the Cognito /logout endpoint with client id and logout URI', () => {
    const url = new URL(cognitoLogoutUrl(PORTAL, ORIGIN));
    expect(`${url.origin}${url.pathname}`).toBe('https://auth.example.org/logout');
    expect(url.searchParams.get('client_id')).toBe('client-1');
    expect(url.searchParams.get('logout_uri')).toBe(`${ORIGIN}/`);
  });
});

describe('isAuthCallback', () => {
  it.each([
    ['https://x.example.org/portal?code=abc&state=s1', true],
    ['https://x.example.org/portal?error=access_denied&state=s1', true],
    ['https://x.example.org/portal?code=abc', false],
    ['https://x.example.org/portal/listings?state=s1', false],
    ['/portal/listings', false],
  ])('%s → %s', (url, expected) => {
    expect(isAuthCallback(url)).toBe(expected);
  });
});

describe('sanitizeReturnUrl', () => {
  it.each([
    ['/portal/listings/l-1?tab=history#top', '/portal/listings/l-1?tab=history#top'],
    ['/portal?code=abc&state=s1&session_state=x&iss=y', '/portal'],
    ['/portal/team?code=abc&state=s1&page=2', '/portal/team?page=2'],
    ['/portal', '/portal'],
    ['/', '/portal'],
    ['/listings/l-1', '/portal'],
    ['/portalx', '/portal'],
    ['https://evil.example.org/portal', '/portal'],
    ['//evil.example.org/portal', '/portal'],
    ['/portal//evil.example.org', '/portal'],
    ['/portal/\\evil', '/portal'],
  ])('%s → %s', (input, expected) => {
    expect(sanitizeReturnUrl(input)).toBe(expected);
  });

  it('falls back to the portal root for missing values', () => {
    expect(sanitizeReturnUrl(undefined)).toBe('/portal');
    expect(sanitizeReturnUrl(null)).toBe('/portal');
  });
});

describe('return URL storage', () => {
  it('remembers a sanitized URL and reads it exactly once', () => {
    const store = storage();
    rememberReturnUrl(store, '/portal/audit?code=x&state=y');
    expect(store.values.get(RETURN_URL_KEY)).toBe('/portal/audit');
    expect(takeReturnUrl(store)).toBe('/portal/audit');
    expect(takeReturnUrl(store)).toBeUndefined();
  });

  it('re-sanitizes a tampered stored value', () => {
    const store = storage();
    store.setItem(RETURN_URL_KEY, 'https://evil.example.org/');
    expect(takeReturnUrl(store)).toBe('/portal');
  });
});

describe('decideAuth (Req 5.1)', () => {
  const base = { requestedUrl: '/portal/team', storedReturnUrl: undefined };

  it('starts the login for an unauthenticated navigation and remembers the requested route', () => {
    expect(decideAuth({ ...base, authenticated: false, callback: false })).toEqual({
      kind: 'login',
      returnUrl: '/portal/team',
    });
  });

  it('lets authenticated users pass', () => {
    expect(decideAuth({ ...base, authenticated: true, callback: false })).toEqual({
      kind: 'allow',
    });
  });

  it('returns to the remembered route after a successful callback', () => {
    expect(
      decideAuth({
        authenticated: true,
        callback: true,
        requestedUrl: '/portal/listings?code=a&state=b',
        storedReturnUrl: '/portal/machine-access',
      }),
    ).toEqual({ kind: 'redirect', url: '/portal/machine-access' });
  });

  it('drops the callback parameters if nothing was remembered', () => {
    expect(
      decideAuth({
        authenticated: true,
        callback: true,
        requestedUrl: '/portal/listings?code=a&state=b',
        storedReturnUrl: undefined,
      }),
    ).toEqual({ kind: 'redirect', url: '/portal/listings' });
  });

  it('does not loop into a new login after a failed callback', () => {
    expect(decideAuth({ ...base, authenticated: false, callback: true })).toEqual({
      kind: 'failed',
    });
  });
});

describe('isManagementApiUrl', () => {
  it.each([
    ['https://manage.example.org/v1/me', 'https://manage.example.org/v1', true],
    ['https://manage.example.org/v1', 'https://manage.example.org/v1/', true],
    ['https://manage.example.org/v10/me', 'https://manage.example.org/v1', false],
    ['https://other.example.org/v1/me', 'https://manage.example.org/v1', false],
    ['/api/listings', 'https://manage.example.org/v1', false],
    ['/management/listings', '/management', true],
    [`${ORIGIN}/management/me`, '/management', true],
    ['/api/listings', '/management', false],
    ['https://cognito-idp.example.org/pool/.well-known/openid-configuration', '/management', false],
  ])('%s with base %s → %s', (url, base, expected) => {
    expect(isManagementApiUrl(url, base, ORIGIN)).toBe(expected);
  });
});
