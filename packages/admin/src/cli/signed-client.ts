import { createHash, createHmac, type Hash, type Hmac } from 'node:crypto';
import { SignatureV4 } from '@smithy/signature-v4';
import { UsageError, type AdminCall } from './args';

/** Base URL of the Admin-API (`https://{id}.execute-api.{region}.amazonaws.com/{stage}`). */
export const ADMIN_URL_ENV = 'OPEN_ESTATE_ADMIN_URL';

/** API Gateway `AWS_IAM` authorization verifies SigV4 signatures of this service. */
export const SIGNING_SERVICE = 'execute-api';

export const REQUEST_TIMEOUT_MS = 30_000;

export type Credentials = ConstructorParameters<typeof SignatureV4>[0]['credentials'];
export type RequestSigner = Pick<SignatureV4, 'sign'>;

export interface AdminTarget {
  baseUrl: URL;
  region: string;
}

export interface AdminResponse {
  status: number;
  /** Parsed JSON; the raw text if the body is not JSON; `null` if empty. */
  body: unknown;
}

type SourceData = string | ArrayBuffer | ArrayBufferView;

const toBuffer = (data: SourceData): Buffer =>
  typeof data === 'string'
    ? Buffer.from(data, 'utf8')
    : ArrayBuffer.isView(data)
      ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
      : Buffer.from(data);

/** SHA-256 / HMAC-SHA-256 on `node:crypto` in the shape the signer expects. */
export class NodeSha256 {
  private hash: Hash | Hmac;

  constructor(private readonly secret?: SourceData) {
    this.hash = this.create();
  }

  update(data: SourceData): void {
    this.hash.update(toBuffer(data));
  }

  digest(): Promise<Uint8Array> {
    return Promise.resolve(new Uint8Array(this.hash.digest()));
  }

  reset(): void {
    this.hash = this.create();
  }

  private create(): Hash | Hmac {
    return this.secret === undefined
      ? createHash('sha256')
      : createHmac('sha256', toBuffer(this.secret));
  }
}

export function createSigner(region: string, credentials: Credentials): RequestSigner {
  return new SignatureV4({ service: SIGNING_SERVICE, region, credentials, sha256: NodeSha256 });
}

const EXECUTE_API_HOST = /^[a-z0-9]+\.execute-api\.([a-z0-9-]+)\.amazonaws\.com(\.cn)?$/;

/** `--region`, then `AWS_REGION`, `AWS_DEFAULT_REGION`, then the execute-api host name. */
export function resolveRegion(
  flag: string | undefined,
  env: NodeJS.ProcessEnv,
  host?: string,
): string | undefined {
  const fromHost = host === undefined ? undefined : EXECUTE_API_HOST.exec(host)?.[1];
  return [flag, env['AWS_REGION'], env['AWS_DEFAULT_REGION'], fromHost]
    .map((value) => value?.trim())
    .find((value) => value !== undefined && value !== '');
}

/** Base URL from `--url` or `OPEN_ESTATE_ADMIN_URL` (HTTPS only) and the signing region. */
export function resolveTarget(
  options: { url?: string; region?: string },
  env: NodeJS.ProcessEnv,
): AdminTarget {
  const raw = options.url ?? env[ADMIN_URL_ENV];
  if (raw === undefined || raw.trim() === '') {
    throw new UsageError(`No Admin-API URL: use --url or set ${ADMIN_URL_ENV}`);
  }
  let baseUrl: URL;
  try {
    baseUrl = new URL(raw.trim());
  } catch {
    throw new UsageError(`Invalid Admin-API URL "${raw}"`);
  }
  if (baseUrl.protocol !== 'https:') throw new UsageError('The Admin-API URL must use https');
  if (baseUrl.search !== '' || baseUrl.hash !== '') {
    throw new UsageError('The Admin-API URL must not contain a query or fragment');
  }
  const region = resolveRegion(options.region, env, baseUrl.hostname);
  if (region === undefined) {
    throw new UsageError('No AWS region: use --region or set AWS_REGION');
  }
  return { baseUrl, region };
}

export interface SendDeps {
  signer: RequestSigner;
  fetch: typeof fetch;
  /** Signing time; the current time if omitted. */
  now?: () => Date;
}

function parseBody(text: string): unknown {
  if (text.trim() === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** Signs the call with SigV4 (`execute-api`) and sends it. */
export async function sendAdminCall(
  call: AdminCall,
  target: AdminTarget,
  deps: SendDeps,
): Promise<AdminResponse> {
  const { baseUrl } = target;
  const path = `${baseUrl.pathname.replace(/\/+$/, '')}${call.path}`;
  const body = call.body === undefined ? undefined : JSON.stringify(call.body);
  const headers: Record<string, string> = {
    host: baseUrl.host,
    accept: 'application/json',
    ...(body !== undefined && { 'content-type': 'application/json' }),
  };

  const signed = await deps.signer.sign(
    {
      method: call.method,
      protocol: baseUrl.protocol,
      hostname: baseUrl.hostname,
      ...(baseUrl.port !== '' && { port: Number(baseUrl.port) }),
      path,
      query: {},
      headers,
      body,
    },
    { signingDate: deps.now?.() ?? new Date() },
  );

  // `host` was signed; fetch derives the identical value from the URL.
  const sendHeaders: Record<string, string> = { ...signed.headers };
  delete sendHeaders['host'];
  const response = await deps.fetch(`${baseUrl.origin}${path}`, {
    method: call.method,
    headers: sendHeaders,
    ...(body !== undefined && { body }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return { status: response.status, body: parseBody(await response.text()) };
}
