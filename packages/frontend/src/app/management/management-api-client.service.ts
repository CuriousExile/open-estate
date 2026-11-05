import { HttpClient, HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { TranslocoService } from '@jsverse/transloco';
import { MeResponse } from '@open-estate/shared';
import { PortalConfigService } from '../auth/portal-config.service';
import {
  createManagementClient,
  managementErrorMessage,
  type HttpMethod,
  type ManagementClient,
  type ManagementError,
  type ManagementRequestOptions,
  type ManagementResult,
  type Transport,
} from './management-client';

/**
 * Transport over Angular's HttpClient, so the bearer interceptor adds the access token. Error
 * statuses resolve like successes; only a missing answer rejects.
 */
function httpTransport(http: HttpClient): Transport {
  return (request) =>
    new Promise((resolve, reject) => {
      const subscription = http
        .request(request.method, request.url, {
          body: request.body,
          headers: new HttpHeaders(request.headers),
          observe: 'response',
          responseType: 'text',
        })
        .subscribe({
          next: (response) =>
            resolve({
              status: response.status,
              headers: response.headers,
              text: response.body ?? '',
            }),
          error: (error: unknown) => {
            if (error instanceof HttpErrorResponse && error.status !== 0) {
              resolve({
                status: error.status,
                headers: error.headers,
                text: typeof error.error === 'string' ? error.error : '',
              });
            } else {
              reject(error instanceof HttpErrorResponse ? new Error(error.message) : error);
            }
          },
        });
      request.signal.addEventListener(
        'abort',
        () => {
          subscription.unsubscribe();
          reject(new Error('aborted'));
        },
        { once: true },
      );
    });
}

/**
 * The portal's only way to read and write data (Req 2.3): Management_API calls with bearer token,
 * 10-s timeout and translated error messages (Req 5.9). Never throws; callers keep their form
 * values on failure.
 */
@Injectable({ providedIn: 'root' })
export class ManagementApiClient {
  private readonly http = inject(HttpClient);
  private readonly portalConfig = inject(PortalConfigService);
  private readonly transloco = inject(TranslocoService);
  private client: ManagementClient | undefined;

  request<T = unknown>(
    method: HttpMethod,
    path: string,
    options?: ManagementRequestOptions<T>,
  ): Promise<ManagementResult<T>> {
    const client = this.resolveClient();
    return client
      ? client.request(method, path, options)
      : Promise.resolve({ ok: false, error: { kind: 'not-configured' } });
  }

  get<T = unknown>(path: string, options?: Omit<ManagementRequestOptions<T>, 'body'>) {
    return this.request<T>('GET', path, options);
  }

  post<T = unknown>(path: string, body: unknown, options?: ManagementRequestOptions<T>) {
    return this.request<T>('POST', path, { ...options, body });
  }

  put<T = unknown>(path: string, body: unknown, options?: ManagementRequestOptions<T>) {
    return this.request<T>('PUT', path, { ...options, body });
  }

  patch<T = unknown>(path: string, body: unknown, options?: ManagementRequestOptions<T>) {
    return this.request<T>('PATCH', path, { ...options, body });
  }

  delete<T = unknown>(path: string, options?: ManagementRequestOptions<T>) {
    return this.request<T>('DELETE', path, options);
  }

  /** `GET /me`: identity and effective permissions (Req 5.6). */
  getMe(options?: { signal?: AbortSignal }): Promise<ManagementResult<MeResponse>> {
    return this.get('/me', { ...options, parse: (value) => MeResponse.parse(value) });
  }

  /** Translated, human-readable message for a failed call; `undefined` if the caller aborted it. */
  errorMessage(error: ManagementError): string | undefined {
    const message = managementErrorMessage(error);
    return message && this.transloco.translate(message.key, message.params ?? {});
  }

  private resolveClient(): ManagementClient | undefined {
    if (this.client) return this.client;
    const state = this.portalConfig.state();
    if (!state.ok) return undefined;
    this.client = createManagementClient({
      baseUrl: state.config.managementApiUrl,
      transport: httpTransport(this.http),
    });
    return this.client;
  }
}
