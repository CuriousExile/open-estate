// Framework-free logic of the portal login (design: Agentur_Portal; Req 5.1). Kept free of Angular
// imports so it can be unit-tested with plain Jest; the library types are type-only imports.
import type { OpenIdConfiguration } from 'angular-auth-oidc-client';
import {
  describeIssues,
  PortalConfigSchema,
  type PortalConfig,
  type RuntimeConfig,
} from '../startup/config-schemas';
import type { LoadState } from '../startup/initialize';

/** Root of the Agentur_Portal and OIDC callback path (IdentityStack `PORTAL_CALLBACK_PATH`). */
export const PORTAL_PATH = '/portal';
/** Target after logout (IdentityStack `PORTAL_LOGOUT_PATH`): the public search. */
export const LOGOUT_PATH = '/';
/** `sessionStorage` key of the route requested before the login redirect. */
export const RETURN_URL_KEY = 'oe.portal.returnUrl';
/** Scopes of the portal app client (IdentityStack). */
export const PORTAL_SCOPES = 'openid email profile';

/** Query parameters of an OIDC authorization response (RFC 6749 §4.1.2, OIDC session management). */
const CALLBACK_PARAMS = ['code', 'state', 'error', 'error_description', 'session_state', 'iss'];

export type PortalConfigState =
  | { ok: true; config: PortalConfig }
  | { ok: false; reason: 'missing' | 'invalid'; detail?: string };

/** Validated `portal` block of `runtime-config.json`. */
export function resolvePortalConfig(
  runtimeConfig: LoadState<RuntimeConfig> | undefined,
): PortalConfigState {
  if (runtimeConfig?.status !== 'loaded' || runtimeConfig.value.portal === undefined) {
    return { ok: false, reason: 'missing' };
  }
  const parsed = PortalConfigSchema.safeParse(runtimeConfig.value.portal);
  return parsed.success
    ? { ok: true, config: parsed.data }
    : { ok: false, reason: 'invalid', detail: describeIssues(parsed.error) };
}

const trimSlash = (url: string): string => url.replace(/\/+$/, '');

/**
 * OIDC client configuration: Authorization Code + PKCE against the Cognito issuer, refresh tokens
 * instead of iframes, tokens kept in the library's default `sessionStorage` (never `localStorage`).
 */
export function buildOidcConfig(config: PortalConfig, origin: string): OpenIdConfiguration {
  return {
    configId: 'portal',
    authority: trimSlash(config.issuer),
    clientId: config.clientId,
    redirectUrl: `${trimSlash(origin)}${PORTAL_PATH}`,
    postLogoutRedirectUri: `${trimSlash(origin)}${LOGOUT_PATH}`,
    responseType: 'code',
    scope: PORTAL_SCOPES,
    silentRenew: true,
    useRefreshToken: true,
    renewTimeBeforeTokenExpiresInSeconds: 60,
    // Cognito's refresh response carries a new id token without nonce.
    ignoreNonceAfterRefresh: true,
    // Identity and permissions come from `GET /me`, not from the userinfo endpoint.
    autoUserInfo: false,
    // No OIDC session iframe at Cognito.
    startCheckSession: false,
    // The bearer token is attached by our own interceptor (Management_API only).
    secureRoutes: [],
    // Without this flag the library calls `router.navigateByUrl(postLoginRoute ?? '/')` (or
    // `unauthorizedRoute`) after processing a code callback inside `checkAuth()`. That navigation
    // supersedes the guard's redirect to the remembered portal route, so the user landed on the
    // public search. The auth guard (`decideAuth`) owns all post-login and failure navigation.
    triggerAuthorizationResultEvent: true,
  };
}

/**
 * Cognito logout endpoint (Cognito publishes no `end_session_endpoint`): ends the Managed Login
 * session and returns to the public search, which must be a registered logout URL.
 */
export function cognitoLogoutUrl(config: PortalConfig, origin: string): string {
  const query = new URLSearchParams({
    client_id: config.clientId,
    logout_uri: `${trimSlash(origin)}${LOGOUT_PATH}`,
  });
  return `${trimSlash(config.cognitoDomainUrl)}/logout?${query.toString()}`;
}

function splitUrl(url: string): { path: string; params: URLSearchParams; hash: string } {
  const hashIndex = url.indexOf('#');
  const hash = hashIndex >= 0 ? url.slice(hashIndex) : '';
  const withoutHash = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  const queryIndex = withoutHash.indexOf('?');
  return {
    path: queryIndex >= 0 ? withoutHash.slice(0, queryIndex) : withoutHash,
    params: new URLSearchParams(queryIndex >= 0 ? withoutHash.slice(queryIndex + 1) : ''),
    hash,
  };
}

/** True if the URL is an authorization response (success or error) of the identity provider. */
export function isAuthCallback(url: string): boolean {
  const { params } = splitUrl(url);
  return params.has('state') && (params.has('code') || params.has('error'));
}

/**
 * Router URL that is safe to return to after login: only paths inside the portal (no open
 * redirect to other origins or the public area), without OIDC callback parameters.
 */
export function sanitizeReturnUrl(url: string | null | undefined): string {
  if (typeof url !== 'string') return PORTAL_PATH;
  const { path, params, hash } = splitUrl(url.trim());
  const inPortal = path === PORTAL_PATH || path.startsWith(`${PORTAL_PATH}/`);
  if (!inPortal || path.includes('//') || path.includes('\\')) return PORTAL_PATH;
  for (const name of CALLBACK_PARAMS) params.delete(name);
  const query = params.toString();
  return `${path}${query === '' ? '' : `?${query}`}${hash}`;
}

/** Minimal `Storage` surface; `sessionStorage` satisfies it. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function rememberReturnUrl(storage: KeyValueStorage, url: string): void {
  storage.setItem(RETURN_URL_KEY, sanitizeReturnUrl(url));
}

/** Reads and clears the remembered route (one-shot). */
export function takeReturnUrl(storage: KeyValueStorage): string | undefined {
  const value = storage.getItem(RETURN_URL_KEY);
  storage.removeItem(RETURN_URL_KEY);
  return value === null ? undefined : sanitizeReturnUrl(value);
}

/** What the auth guard does with a navigation into the portal. */
export type AuthDecision =
  | { kind: 'allow' }
  /** Authenticated after the callback: continue at the originally requested route. */
  | { kind: 'redirect'; url: string }
  /** Not authenticated: remember `returnUrl`, then start the login at the identity provider. */
  | { kind: 'login'; returnUrl: string }
  /** The identity provider answered with an error or the code exchange failed — no new redirect loop. */
  | { kind: 'failed' };

export interface AuthDecisionInput {
  authenticated: boolean;
  /** The current browser URL is an authorization response ({@link isAuthCallback}). */
  callback: boolean;
  /** Router URL of the navigation. */
  requestedUrl: string;
  /** Route remembered before the login redirect ({@link takeReturnUrl}). */
  storedReturnUrl: string | undefined;
}

/** Req 5.1: login for unauthenticated users, afterwards back to the requested route. */
export function decideAuth(input: AuthDecisionInput): AuthDecision {
  if (input.callback) {
    if (!input.authenticated) return { kind: 'failed' };
    return {
      kind: 'redirect',
      url: input.storedReturnUrl ?? sanitizeReturnUrl(input.requestedUrl),
    };
  }
  if (input.authenticated) return { kind: 'allow' };
  return { kind: 'login', returnUrl: sanitizeReturnUrl(input.requestedUrl) };
}

/**
 * True if a request goes to the Management_API — the only target that receives the access token
 * (not the Search_API, Cognito or static files). Both URLs may be relative to `origin`.
 */
export function isManagementApiUrl(url: string, managementApiUrl: string, origin: string): boolean {
  let target: URL;
  let base: URL;
  try {
    target = new URL(url, origin);
    base = new URL(managementApiUrl, origin);
  } catch {
    return false;
  }
  if (target.origin !== base.origin) return false;
  const prefix = base.pathname.replace(/\/+$/, '');
  return prefix === '' || target.pathname === prefix || target.pathname.startsWith(`${prefix}/`);
}
