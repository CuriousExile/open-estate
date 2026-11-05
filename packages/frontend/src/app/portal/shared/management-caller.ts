// Structural subset of `ManagementApiClient` used by the framework-free API modules of the portal
// areas, so they can be tested with plain Jest against a fake.
import type {
  ManagementError,
  ManagementRequestOptions,
  ManagementResult,
} from '../../management/management-client';

export interface ManagementCaller {
  get<T = unknown>(
    path: string,
    options?: Omit<ManagementRequestOptions<T>, 'body'>,
  ): Promise<ManagementResult<T>>;
  post<T = unknown>(
    path: string,
    body: unknown,
    options?: ManagementRequestOptions<T>,
  ): Promise<ManagementResult<T>>;
  patch<T = unknown>(
    path: string,
    body: unknown,
    options?: ManagementRequestOptions<T>,
  ): Promise<ManagementResult<T>>;
  delete<T = unknown>(
    path: string,
    options?: ManagementRequestOptions<T>,
  ): Promise<ManagementResult<T>>;
}

/** Fields named by a failed call (e.g. `email`, `permissions.1`), in answer order, deduplicated. */
export function errorFields(error: ManagementError): string[] {
  if (error.kind !== 'api') return [];
  return [...new Set(error.errors.flatMap((e) => (e.field === undefined ? [] : [e.field])))];
}

/** Catalog code of the first error of a failed API call, if any. */
export const errorCode = (error: ManagementError): string | undefined =>
  error.kind === 'api' ? error.errors[0]?.code : undefined;

/** Translation key and parameters of one line in a confirmation dialog. */
export interface ImpactLine {
  readonly key: string;
  readonly params: Readonly<Record<string, number>>;
}

/**
 * Lines for the counts of a `?dryRun=true` answer (Req 10.8): `{prefix}.affectedUsers` and
 * `{prefix}.affectedListings`, each only if the API returned it.
 */
export function dryRunImpact(
  preview: { affectedUsers?: number | undefined; affectedListings?: number | undefined },
  prefix: string,
): ImpactLine[] {
  const lines: ImpactLine[] = [];
  if (preview.affectedUsers !== undefined) {
    lines.push({ key: `${prefix}.affectedUsers`, params: { count: preview.affectedUsers } });
  }
  if (preview.affectedListings !== undefined) {
    lines.push({ key: `${prefix}.affectedListings`, params: { count: preview.affectedListings } });
  }
  return lines;
}
