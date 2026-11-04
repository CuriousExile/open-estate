import { describeE2e, errorCode, runMarker, stackOutput, timedFetch } from './deployed-env';

/**
 * Admin-API of a deployed environment without administrator permission (task 19.5): unsigned
 * calls of `/admin/*` are rejected by the IAM authorizer with 403 `FORBIDDEN` before any Lambda
 * runs, so no data can change (Req 18.11). The marker id names no existing listing or request.
 *
 * **Validates: Requirements 18.11**
 */
describeE2e('Admin API without permission (deployed)', () => {
  let adminUrl: string;
  const marker = runMarker();

  beforeAll(async () => {
    adminUrl = await stackOutput('Admin', 'AdminApiUrl');
  });

  test.each([
    ['POST', '/admin/deletions', { listingId: marker }],
    ['GET', `/admin/deletions/${marker}`, undefined],
    ['DELETE', `/admin/deletion-blocklist/${marker}`, undefined],
  ])('%s %s → 403 FORBIDDEN (Req 18.11)', async (method, path, body) => {
    const response = await timedFetch(`${adminUrl.replace(/\/+$/, '')}${path}`, {
      method,
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    expect({ status: response.status, code: errorCode(response.body) }).toEqual({
      status: 403,
      code: 'FORBIDDEN',
    });
  });
});
