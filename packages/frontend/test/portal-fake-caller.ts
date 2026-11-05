import type {
  ManagementRequestOptions,
  ManagementResult,
} from '../src/app/management/management-client';
import type { ManagementCaller } from '../src/app/portal/shared/management-caller';

export interface RecordedCall {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
  query?: ManagementRequestOptions<unknown>['query'];
}

/** Records calls and answers each with `respond`; `parse` runs like in the real client. */
export function fakeCaller(respond: (call: RecordedCall) => unknown): {
  api: ManagementCaller;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const handle = async <T>(
    call: RecordedCall,
    options: ManagementRequestOptions<T> = {},
  ): Promise<ManagementResult<T>> => {
    const recorded = { ...call, ...(options.query && { query: options.query }) };
    calls.push(recorded);
    const value = respond(recorded);
    return { ok: true, value: options.parse ? options.parse(value) : (value as T) };
  };
  return {
    calls,
    api: {
      get: (path, options) => handle({ method: 'GET', path }, options),
      post: (path, body, options) => handle({ method: 'POST', path, body }, options),
      patch: (path, body, options) => handle({ method: 'PATCH', path, body }, options),
      delete: (path, options) => handle({ method: 'DELETE', path }, options),
    },
  };
}
