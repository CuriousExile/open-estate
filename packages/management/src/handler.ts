import type { AuditService } from '@open-estate/core';
import type { ActorRef, ApiError, Channel, Principal } from '@open-estate/shared';
import type { ManagementAccessGuard } from './access-guard';
import {
  failure,
  headerValue,
  replyStatus,
  serviceUnavailable,
  toProxyResult,
  type ManagementHandler,
  type ManagementRequest,
  type Reply,
} from './http';
import type { Route, Router } from './router';

// Request pipeline of the Management_API (design: "Request-Pfade", "Error Handling"):
// route match → AccessGuard (IP limit → Authenticator → actor limit; public routes: IP limit
// only) → Zod parsing → route handler → audit of 401/403 → `ErrorResponse`. The whole request
// runs under a 4.5-s deadline; exceeding it or any unexpected failure yields 503
// `SERVICE_UNAVAILABLE`, never a 5xx outside the error catalog.

/** Request deadline: below API Gateway's 29 s and the portal's 10 s, leaves room for the reply. */
export const MANAGEMENT_REQUEST_DEADLINE_MS = 4_500;

/** Minimal logger (Powertools `Logger` satisfies it). */
export interface ManagementLogger {
  error(message: string, attributes: Record<string, unknown>): void;
}

export interface ManagementHandlerDeps {
  router: Router;
  guard: ManagementAccessGuard;
  audit: Pick<AuditService, 'append'>;
  logger: ManagementLogger;
  /** Default {@link MANAGEMENT_REQUEST_DEADLINE_MS}; injectable for tests. */
  deadlineMs?: number;
}

/** Actor of an audit entry (Req 7.9 shape). */
export function principalActor(principal: Principal): ActorRef {
  return principal.kind === 'user'
    ? { kind: 'user', userId: principal.userId, displayName: principal.displayName }
    : { kind: 'machine', keyId: principal.keyId, label: principal.label };
}

/** Änderungskanal of a principal (Req 10.5): Plattform_Admin → ADMIN, machine → API, else PORTAL. */
export function principalChannel(principal: Principal): Channel {
  if (principal.kind === 'machine') return 'API';
  return principal.role === 'PLATFORM_ADMIN' ? 'ADMIN' : 'PORTAL';
}

const AUDIT_TARGET_MAX = 256;
const isDenied = (status: number) => status === 401 || status === 403;

const notFound = (method: string, path: string): Reply =>
  failure({ code: 'NOT_FOUND', message: `No route ${method} ${path}` });

function bodyText(event: ManagementRequest): string {
  if (event.body === null) return '';
  return event.isBase64Encoded === true
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;
}

function queryOf(event: ManagementRequest): Record<string, string> {
  const query: Record<string, string> = {};
  for (const [key, value] of Object.entries(event.queryStringParameters ?? {})) {
    if (value !== undefined) query[key] = value;
  }
  return query;
}

const errorName = (cause: unknown) => (cause instanceof Error ? cause.name : typeof cause);

class DeadlineExceeded extends Error {
  override readonly name = 'DeadlineExceeded';
}

/** Runs `work` with an abort signal; rejects with {@link DeadlineExceeded} after `ms`. */
async function withDeadline<T>(ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new DeadlineExceeded(`Request deadline of ${ms} ms exceeded`));
    }, ms);
  });
  try {
    return await Promise.race([work(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

interface Outcome {
  reply: Reply;
  route: Route;
  principal?: Principal;
}

/**
 * Builds the Management_API handler. Rejections with 401 or 403 — from the Authenticator or from
 * a use case's `authorize` — are appended as `access-denied` audit entries with actor (if known),
 * operation (`METHOD /template`), target (request path) and result code (Req 2.8). A failing
 * audit write is logged and does not turn the denial into a success or a 503.
 */
export function createManagementHandler(deps: ManagementHandlerDeps): ManagementHandler {
  const deadlineMs = deps.deadlineMs ?? MANAGEMENT_REQUEST_DEADLINE_MS;

  async function process(event: ManagementRequest, signal: AbortSignal): Promise<Reply> {
    const method = event.httpMethod.toUpperCase();
    const sourceIp = event.requestContext.identity.sourceIp;
    const found = deps.router.match(method, event.path);
    if (found === undefined) {
      // Unknown routes still count against the IP limit (no free probing).
      const ip = await deps.guard.admitIp(sourceIp);
      return ip.ok ? notFound(method, event.path) : failure(ip.error);
    }
    const { route, params } = found;
    const input = {
      params,
      query: queryOf(event),
      body: bodyText(event),
      signal,
      ...(event.headers !== undefined && event.headers !== null && { headers: event.headers }),
    };

    if (route.public) {
      const ip = await deps.guard.admitIp(sourceIp);
      return ip.ok ? route.run(input, undefined) : failure(ip.error);
    }

    const admitted = await deps.guard.admit({
      sourceIp,
      authorization: headerValue(event, 'Authorization'),
    });
    const outcome: Outcome = admitted.ok
      ? { reply: await route.run(input, admitted.value), route, principal: admitted.value }
      : {
          // The reply carries the error only; an identified caller is for the audit entry.
          reply: failure(admitted.error),
          route,
          ...(admitted.principal !== undefined && { principal: admitted.principal }),
        };
    await auditDenial(event, method, outcome);
    return outcome.reply;
  }

  async function auditDenial(event: ManagementRequest, method: string, outcome: Outcome) {
    const { reply, route, principal } = outcome;
    if (reply.kind !== 'failure' || !isDenied(replyStatus(reply))) return;
    const code: ApiError['code'] | undefined = reply.errors[0]?.code;
    try {
      await deps.audit.append({
        category: 'access-denied',
        ...(principal !== undefined && {
          actor: principalActor(principal),
          channel: principalChannel(principal),
          ...('agencyId' in principal && { agencyId: principal.agencyId }),
        }),
        action: `${method} ${route.path}`,
        target: event.path.slice(0, AUDIT_TARGET_MAX),
        result: code ?? 'FORBIDDEN',
      });
    } catch (cause) {
      deps.logger.error('Management API: access-denied audit failed', {
        errorName: errorName(cause),
      });
    }
  }

  return async (event) => {
    let reply: Reply;
    try {
      reply = await withDeadline(deadlineMs, (signal) => process(event, signal));
    } catch (cause) {
      // Only the error class: neither bodies, tokens nor secrets end up in the log.
      deps.logger.error('Management API: request failed', {
        errorName: errorName(cause),
        method: event.httpMethod,
      });
      reply = serviceUnavailable();
    }
    return toProxyResult(reply);
  };
}
