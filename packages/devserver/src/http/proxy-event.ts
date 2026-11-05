import type { IncomingHttpHeaders } from 'node:http';

// DEV ONLY: translation between Node HTTP requests and the API Gateway REST proxy events the
// Lambda handlers expect (and their results back), so the local server runs the real handlers.

/** A buffered Node request. */
export interface RawHttpRequest {
  method: string;
  /** Request target as received, e.g. `/api/listings?city=Berlin`. */
  url: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
  remoteAddress?: string;
}

/** The fields of `APIGatewayProxyEvent` the handlers of api, mcp and management read. */
export interface ProxyEvent {
  httpMethod: string;
  /** Path without the stripped prefix (API Gateway: without stage). */
  path: string;
  /** Matched resource template (`/listings/{id}`); `undefined` if none matched. */
  resource?: string;
  pathParameters: Record<string, string> | null;
  headers: Record<string, string>;
  multiValueHeaders: Record<string, string[]>;
  queryStringParameters: Record<string, string> | null;
  multiValueQueryStringParameters: Record<string, string[]> | null;
  body: string | null;
  isBase64Encoded: boolean;
  requestContext: { identity: { sourceIp: string } };
}

/** The fields of `APIGatewayProxyResult` written back. */
export interface ProxyResult {
  statusCode: number;
  headers?: Record<string, boolean | number | string> | undefined;
  multiValueHeaders?: Record<string, (boolean | number | string)[]> | undefined;
  body: string;
  isBase64Encoded?: boolean | undefined;
}

export interface ProxyEventOptions {
  /** Prefix removed from the path, e.g. `/api` (like an API Gateway stage). */
  stripPrefix?: string;
  /** Resource templates to match the path against (Search_API routing by `resource`). */
  resources?: readonly string[];
}

const TEMPLATE_PARAM = /^\{([A-Za-z][A-Za-z0-9]*)\}$/;

/**
 * First template of `templates` matching `path` segment by segment; parameters keep their raw
 * (still URL-encoded) value, as API Gateway passes them on. Literal templates win over
 * parameterized ones because they are tried first.
 */
export function matchResource(
  templates: readonly string[],
  path: string,
): { resource: string; pathParameters: Record<string, string> | null } | undefined {
  const segments = path.split('/');
  const ordered = [...templates].sort((a, b) => Number(a.includes('{')) - Number(b.includes('{')));
  for (const template of ordered) {
    const parts = template.split('/');
    if (parts.length !== segments.length) continue;
    const params: Record<string, string> = {};
    const matches = parts.every((part, index) => {
      const segment = segments[index] ?? '';
      const name = TEMPLATE_PARAM.exec(part)?.[1];
      if (name === undefined) return part === segment;
      if (segment === '') return false;
      params[name] = segment;
      return true;
    });
    if (matches) {
      return {
        resource: template,
        pathParameters: Object.keys(params).length > 0 ? params : null,
      };
    }
  }
  return undefined;
}

/** Content types API Gateway passes as text; everything else is base64-encoded. */
const TEXT_TYPE =
  /^(text\/|application\/([\w.+-]*\+)?(json|xml|x-www-form-urlencoded|javascript))/i;

function splitHeaders(headers: IncomingHttpHeaders) {
  const single: Record<string, string> = {};
  const multi: Record<string, string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const values = Array.isArray(value) ? value : [value];
    single[name] = values.join(', ');
    multi[name] = [...values];
  }
  return { single, multi };
}

function splitQuery(search: URLSearchParams) {
  const single: Record<string, string> = {};
  const multi: Record<string, string[]> = {};
  for (const [name, value] of search) {
    // API Gateway's single-value map keeps the last value of a repeated parameter.
    single[name] = value;
    multi[name] = [...(multi[name] ?? []), value];
  }
  const empty = Object.keys(single).length === 0;
  return { single: empty ? null : single, multi: empty ? null : multi };
}

/** Path of `url` without `prefix`; `/` for the bare prefix. */
export function stripPathPrefix(path: string, prefix: string | undefined): string {
  if (prefix === undefined || prefix === '') return path;
  if (path === prefix) return '/';
  return path.startsWith(`${prefix}/`) ? path.slice(prefix.length) : path;
}

/** Builds the proxy event of a buffered request. */
export function toProxyEvent(request: RawHttpRequest, options: ProxyEventOptions = {}): ProxyEvent {
  // The base only serves to parse the request target; host and scheme are never used.
  const url = new URL(request.url, 'http://localhost');
  const path = stripPathPrefix(url.pathname, options.stripPrefix);
  const matched =
    options.resources === undefined ? undefined : matchResource(options.resources, path);
  const headers = splitHeaders(request.headers);
  const query = splitQuery(url.searchParams);
  const contentType = headers.single['content-type'] ?? '';
  const hasBody = request.body.length > 0;
  const binary = hasBody && contentType !== '' && !TEXT_TYPE.test(contentType);
  return {
    httpMethod: request.method.toUpperCase(),
    path,
    ...(matched !== undefined && { resource: matched.resource }),
    pathParameters: matched?.pathParameters ?? null,
    headers: headers.single,
    multiValueHeaders: headers.multi,
    queryStringParameters: query.single,
    multiValueQueryStringParameters: query.multi,
    body: hasBody ? request.body.toString(binary ? 'base64' : 'utf8') : null,
    isBase64Encoded: binary,
    requestContext: { identity: { sourceIp: request.remoteAddress ?? '127.0.0.1' } },
  };
}

/** Status, headers and body bytes of a proxy result, ready for `res.writeHead`/`res.end`. */
export function fromProxyResult(result: ProxyResult): {
  status: number;
  headers: Record<string, string | string[]>;
  body: Buffer;
} {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(result.headers ?? {})) headers[name] = String(value);
  for (const [name, values] of Object.entries(result.multiValueHeaders ?? {})) {
    headers[name] = values.map(String);
  }
  return {
    status: result.statusCode,
    headers,
    body: Buffer.from(result.body, result.isBase64Encoded === true ? 'base64' : 'utf8'),
  };
}
