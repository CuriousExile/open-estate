/** Downstream (search backend) unreachable, failed or deadline exceeded → 503 (Req 9.5, 9.6). */
export class ServiceUnavailableError extends Error {
  override readonly name = 'ServiceUnavailableError';
  readonly code = 'SERVICE_UNAVAILABLE';
}
