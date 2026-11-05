import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import openApi31Schema from '@seriousme/openapi-schema-validator/schemas/v3.1/schema.json';
import { CloudWatchClient } from '@aws-sdk/client-cloudwatch';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { S3Client } from '@aws-sdk/client-s3';
import { SFNClient } from '@aws-sdk/client-sfn';
import { SSMClient } from '@aws-sdk/client-ssm';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { InMemoryAuditService, InMemoryIdentityDirectory } from '@open-estate/core';
import { PERMISSIONS } from '@open-estate/shared';
import {
  buildManagementOpenApiDocument,
  createRouter,
  createRoutes,
  defineRoute,
  MANAGEMENT_ENV,
  OPERATIONS,
  ROUTE_GROUPS,
  success,
  UndocumentedRouteError,
  type Route,
} from '../src';
import { createIdentityRoutes, IDENTITY_ENV } from '../src/routes/identity';
import { createListingRouteGroup, LISTING_ROUTES_ENV } from '../src/routes/listings';
import { createMonitoringRouteGroup, MONITORING_ENV } from '../src/routes/monitoring';
import { openApiRoutes } from '../src/routes/openapi';
import { createPlatformRouteGroup, PLATFORM_ENV } from '../src/routes/platform';

const NOW = Date.parse('2026-11-05T12:00:00Z');
const REGION = 'eu-central-1';

/** Every variable of every group, so the production route list can be built without AWS. */
function fullEnv(): Record<string, string> {
  const names: string[] = [
    IDENTITY_ENV,
    LISTING_ROUTES_ENV,
    MONITORING_ENV,
    PLATFORM_ENV,
    MANAGEMENT_ENV,
  ]
    .flatMap((group) => Object.values(group) as unknown[])
    .filter((name): name is string => typeof name === 'string');
  const env = Object.fromEntries(names.map((name) => [name, `${name.toLowerCase()}-value`]));
  return {
    ...env,
    [PLATFORM_ENV.reloadFunctions]: 'api-fn,mcp-fn',
    // ARN-shaped values for variables the platform wiring may parse.
    ...Object.fromEntries(
      Object.values(PLATFORM_ENV)
        .filter((name) => /ARN/.test(name))
        .map((name) => [name, 'arn:aws:states:eu-central-1:123456789012:stateMachine:x']),
    ),
  };
}

function productionRoutes(): Route[] {
  // The listing group starts loading its config from S3 at init; keep it offline.
  const s3 = new S3Client({ region: REGION });
  jest.spyOn(s3, 'send').mockImplementation(async () => {
    throw new Error('offline');
  });
  // Same groups as `ROUTE_GROUPS`, with region-bound clients (no IMDS lookups in tests).
  const groups = [
    createIdentityRoutes({ identity: new InMemoryIdentityDirectory() }),
    createListingRouteGroup({ s3 }),
    createMonitoringRouteGroup({ cloudWatch: new CloudWatchClient({ region: REGION }) }),
    createPlatformRouteGroup({
      sfn: new SFNClient({ region: REGION }),
      lambda: new LambdaClient({ region: REGION }),
    }),
    openApiRoutes,
  ];
  expect(groups.map((g) => g.name)).toEqual(ROUTE_GROUPS.map((g) => g.name));
  return createRoutes(
    {
      env: fullEnv(),
      clients: {
        dynamo: DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION })),
        ssm: new SSMClient({ region: REGION }),
      },
      shared: {
        frontendOrigin: 'https://portal.example.com',
        audit: new InMemoryAuditService(),
        clock: () => NOW,
      },
    },
    groups,
  );
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const routes = productionRoutes();
const openapiRoute = routes.find((route) => route.path === '/openapi.json');

async function servedDocument(): Promise<Json> {
  const router = createRouter(routes);
  const match = router.match('GET', '/openapi.json');
  if (match === undefined) throw new Error('no /openapi.json route');
  const reply = await match.route.run(
    { params: {}, query: {}, body: '', signal: new AbortController().signal },
    undefined,
  );
  if (reply.kind !== 'success') throw new Error('openapi failed');
  return JSON.parse(JSON.stringify(reply.body)) as Json;
}

const operations = (doc: Json) =>
  Object.entries(doc['paths'] as Record<string, Record<string, Json>>).flatMap(([path, item]) =>
    Object.entries(item).map(([method, op]) => ({ key: `${method.toUpperCase()} ${path}`, op })),
  );

describe('GET /openapi.json', () => {
  it('is a public route registered last', () => {
    expect(openapiRoute?.public).toBe(true);
    expect(routes.at(-1)).toBe(openapiRoute);
    expect(routes.filter((route) => !route.public)).toHaveLength(routes.length - 1);
  });

  it('serves a valid OpenAPI 3.1 document', async () => {
    const doc = await servedDocument();
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    addFormats(ajv);
    ajv.addFormat('media-range', true);
    const validate = ajv.compile(openApi31Schema);
    expect(validate(doc)).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
    expect(doc['openapi']).toBe('3.1.0');
  });

  it('documents every registered route exactly once', async () => {
    const doc = await servedDocument();
    const documented = operations(doc).map(({ key }) => key);
    expect(documented.sort()).toEqual(routes.map((r) => `${r.method} ${r.path}`).sort());
    expect(Object.keys(OPERATIONS).sort()).toEqual([...documented].sort());
  });

  it('names the required permission and the error codes of every operation', async () => {
    const doc = await servedDocument();
    for (const { key, op } of operations(doc)) {
      const permission = op['x-required-permission'];
      expect([...PERMISSIONS, 'authenticated', 'public']).toContain(permission);
      const statuses = Object.keys(op['responses']);
      expect(statuses).toEqual(expect.arrayContaining(['429', '503']));
      if (permission === 'public') {
        expect(op['security']).toEqual([]);
        continue;
      }
      expect({ key, statuses }).toEqual({
        key,
        statuses: expect.arrayContaining(['401', '403']),
      });
      expect(op['x-permission-holders'].roles).toContain('PLATFORM_ADMIN');
    }
    const all = new Set(operations(doc).flatMap(({ op }) => Object.keys(op['responses'])));
    for (const status of ['401', '403', '404', '409', '429']) expect(all).toContain(status);
  });

  it('derives permissions, holders and conflicts per operation', async () => {
    const doc = await servedDocument();
    const replace = doc['paths']['/listings/{id}']['put'];
    expect(replace['x-required-permission']).toBe('listing:write');
    expect(replace['x-permission-holders']).toEqual({
      roles: ['AGENCY_MEMBER', 'AGENCY_ADMIN', 'PLATFORM_ADMIN'],
      machineAccess: true,
    });
    expect(replace['responses']['409']['x-error-codes']).toEqual([
      'VERSION_CONFLICT',
      'DELETION_BLOCKED',
      'CUSTOM_ID_TAKEN',
    ]);
    expect(replace['responses']['404']['x-error-codes']).toEqual(['NOT_FOUND']);
    expect(replace['requestBody']['required']).toBe(true);

    const members = doc['paths']['/agencies/{agencyId}/members']['post'];
    expect(members['x-permission-holders']).toEqual({
      roles: ['AGENCY_ADMIN', 'PLATFORM_ADMIN'],
      machineAccess: false,
    });
    expect(doc['paths']['/me']['get']['x-required-permission']).toBe('authenticated');
  });

  it('documents parameters with types and value ranges', async () => {
    const doc = await servedDocument();
    const params = (path: string, method = 'get') =>
      Object.fromEntries(
        (doc['paths'][path][method]['parameters'] as Json[]).map((p) => [p['name'], p]),
      );

    const list = params('/listings');
    expect(list['pageSize']).toMatchObject({
      in: 'query',
      required: false,
      schema: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
    });
    expect(list['status']['schema']['enum']).toEqual(['ACTIVE', 'INACTIVE']);
    expect(list['q']['schema']).toMatchObject({ type: 'string', minLength: 1 });

    expect(params('/listings/{id}')['id']).toMatchObject({ in: 'path', required: true });
    expect(params('/listings/{id}/diff')['from']).toMatchObject({
      required: true,
      schema: { type: 'integer', minimum: 1 },
    });
    // Intersection schemas (connector runs) are flattened into single parameters.
    const runs = params('/monitoring/connector-runs');
    expect(runs['problemsOnly']['schema']['enum']).toEqual(['true', 'false']);
    expect(runs['pageToken']['schema']).toMatchObject({ maxLength: 1024 });
    expect(params('/metrics/{code}')['from']).toMatchObject({ required: true });
    expect(params('/agencies/{agencyId}/members/{userId}', 'delete')['dryRun']).toMatchObject({
      schema: { type: 'boolean', default: false },
    });
  });

  it('documents listing bodies in their API representation', async () => {
    const doc = await servedDocument();
    const schema =
      doc['paths']['/listings']['post']['requestBody']['content']['application/json']['schema'];
    const serialized = JSON.stringify(schema);
    expect(serialized).toContain('"content"');
    expect(serialized).toContain('"customId"');
    expect(doc['components']['schemas']['ListingView']).toBeDefined();
  });
});

describe('buildManagementOpenApiDocument', () => {
  it('rejects routes without documentation', () => {
    const route = defineRoute({
      method: 'GET',
      path: '/undocumented',
      handle: async () => success(200),
    });
    expect(() => buildManagementOpenApiDocument([route])).toThrow(UndocumentedRouteError);
  });
});
