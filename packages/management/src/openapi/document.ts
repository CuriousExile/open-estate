import {
  GRANTABLE_MACHINE_PERMISSIONS,
  requestSchemaOverride,
  ROLE_PERMISSIONS,
  ROLES,
  type ErrorCode,
  type Permission,
} from '@open-estate/shared';
import { z } from 'zod';
import {
  createDocument,
  type oas32,
  type ZodOpenApiOperationObject,
  type ZodOpenApiPathsObject,
  type ZodOpenApiResponseObject,
} from 'zod-openapi';
import type { Route } from '../router';
import { COMPONENT_SCHEMAS, type ComponentName } from './components';
import { OPERATIONS, type OperationDoc, type RequiredPermission } from './operations';

// OpenAPI 3.1 document of the Management_API (design: "Management_API", Req 16.2), generated with
// zod-openapi like the Search_API document: for every registered route the required permission
// (`x-required-permission`, roles from `shared/permissions.ts`), every parameter with type and
// bounds (from the route's Zod schemas), request body, success responses and the error responses
// 400/401/403/404/409/429/503 with their catalog codes (`x-error-codes`).

export const MANAGEMENT_API_TITLE = 'open-estate Management API';
export const MANAGEMENT_API_VERSION = '0.0.0';

export type ManagementOpenApiDocument = ReturnType<typeof createDocument>;

/** Thrown at init if a registered route has no entry in the documentation catalog. */
export class UndocumentedRouteError extends Error {
  constructor(readonly routes: readonly string[]) {
    super(`Routes without OpenAPI documentation: ${routes.join(', ')}`);
    this.name = 'UndocumentedRouteError';
  }
}

const routeKey = (route: Pick<Route, 'method' | 'path'>) => `${route.method} ${route.path}`;

// ---------------------------------------------------------------------------------------------
// Components and error responses
// ---------------------------------------------------------------------------------------------

/** See the Search_API document: components are referenced and rendered in input mode only. */
function componentSchemas(): Record<string, z.ZodType> {
  return Object.fromEntries(
    Object.entries(COMPONENT_SCHEMAS).map(([id, schema]) => [
      id,
      (schema as z.ZodType).meta({ id, unusedIO: 'input' }),
    ]),
  );
}

const ref = (name: ComponentName) => ({ $ref: `#/components/schemas/${name}` });
const jsonContent = (schema: object) => ({ 'application/json': { schema } });
const errorContent = jsonContent(ref('ErrorResponse'));

const VALIDATION_CODES = [
  'INVALID_PARAMETER',
  'INVALID_RANGE',
] as const satisfies readonly ErrorCode[];
const PAGING_CODES = ['INVALID_PAGE_SIZE', 'INVALID_PAGE_TOKEN'] as const;
const AUTH_CODES = ['AUTH_MISSING', 'AUTH_INVALID', 'MACHINE_ACCESS_EXPIRED'] as const;
const FORBIDDEN_CODES = ['FORBIDDEN', 'AGENCY_SUSPENDED'] as const;

function errorResponse(
  description: string,
  codes: readonly ErrorCode[],
  extra: Partial<ZodOpenApiResponseObject> = {},
): ZodOpenApiResponseObject {
  return {
    description: `${description} Error codes: ${codes.join(', ')}.`,
    'x-error-codes': [...codes],
    content: errorContent,
    ...extra,
  };
}

const RATE_LIMITED = errorResponse(
  'Rate limit exceeded (per IP before, per actor after authentication).',
  ['RATE_LIMITED'],
  {
    headers: {
      'Retry-After': {
        required: true,
        description: 'Seconds until the next admitted request',
        schema: { type: 'integer', minimum: 1 },
      },
    },
  },
);
const UNAVAILABLE = errorResponse('Temporarily unavailable or request deadline exceeded.', [
  'SERVICE_UNAVAILABLE',
]);

const unique = (codes: readonly ErrorCode[]) => [...new Set(codes)];

/** Error responses of one operation. */
function errorResponses(doc: OperationDoc, route: Route): Record<number, ZodOpenApiResponseObject> {
  const responses: Record<number, ZodOpenApiResponseObject> = {};
  const hasInput =
    route.schemas.params !== undefined ||
    route.schemas.query !== undefined ||
    route.schemas.body !== undefined ||
    doc.body !== undefined;
  const badRequest = unique([
    ...(hasInput ? VALIDATION_CODES : []),
    ...(querySchemaHas(route, 'pageToken') ? PAGING_CODES : []),
    ...(doc.badRequest ?? []),
  ]);
  if (badRequest.length > 0) {
    responses[400] = errorResponse('Invalid request; one error per violation.', badRequest);
  }
  if (doc.permission !== 'public') {
    responses[401] = errorResponse('Missing, invalid or expired credentials.', AUTH_CODES);
    responses[403] = errorResponse(
      'Missing permission or suspended agency.',
      unique([...FORBIDDEN_CODES, ...(doc.forbidden ?? [])]),
    );
    // Default: resources addressed by path or an `agencyId` filter may not exist or be foreign.
    const addressed = route.path.includes('{') || querySchemaHas(route, 'agencyId');
    const notFoundCodes = doc.notFound ?? (addressed ? (['NOT_FOUND'] as const) : []);
    if (notFoundCodes.length > 0) {
      responses[404] = errorResponse(
        'Resource not found, or outside the caller’s agency.',
        notFoundCodes,
      );
    }
    if (doc.conflicts !== undefined && doc.conflicts.length > 0) {
      responses[409] = errorResponse('Conflict with the current state.', doc.conflicts);
    }
  }
  responses[429] = RATE_LIMITED;
  responses[503] = UNAVAILABLE;
  return responses;
}

// ---------------------------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------------------------

type JsonSchema = Record<string, unknown>;

/** Request-side JSON Schema of a route input schema, like the Search_API parameters. */
function inputJsonSchema(schema: z.ZodType): JsonSchema {
  const json = z.toJSONSchema(schema, {
    io: 'input',
    unrepresentable: 'any',
    override: requestSchemaOverride,
  }) as JsonSchema;
  delete json['$schema'];
  return json;
}

/** Properties and required names of an object schema, merged across `allOf` (intersections). */
function objectMembers(json: JsonSchema): {
  properties: Record<string, JsonSchema>;
  required: Set<string>;
} {
  const properties: Record<string, JsonSchema> = {};
  const required = new Set<string>();
  const visit = (node: JsonSchema) => {
    Object.assign(properties, (node['properties'] as Record<string, JsonSchema> | undefined) ?? {});
    for (const name of (node['required'] as string[] | undefined) ?? []) required.add(name);
    for (const part of (node['allOf'] as JsonSchema[] | undefined) ?? []) visit(part);
  };
  visit(json);
  return { properties, required };
}

function querySchemaHas(route: Route, name: string): boolean {
  const query = route.schemas.query;
  return query !== undefined && name in objectMembers(inputJsonSchema(query)).properties;
}

const PARAMETER_DOCS: Record<string, string> = {
  agencyId: 'Agency; Plattform_Admins choose it, agency actors may only give their own.',
  ids: 'Comma-separated listing ids (1–50): returns those the caller may read, without other filters or paging.',
  pageSize: 'Number of entries per page.',
  pageToken: 'nextPageToken of the previous page.',
  dryRun: 'true: report the affected listings/users without changing anything.',
  from: 'Start of the period (ISO 8601) or first version.',
  to: 'End of the period (ISO 8601) or second version.',
};

function parameters(route: Route): oas32.ParameterObject[] {
  const result: oas32.ParameterObject[] = [];
  const add = (location: 'path' | 'query', schema: z.ZodType | undefined) => {
    if (schema === undefined) return;
    const { properties, required } = objectMembers(inputJsonSchema(schema));
    for (const [name, property] of Object.entries(properties)) {
      const { description, ...rest } = property;
      const text = (description as string | undefined) ?? PARAMETER_DOCS[name];
      result.push({
        in: location,
        name,
        required: location === 'path' || required.has(name),
        ...(text !== undefined && { description: text }),
        schema: rest as oas32.SchemaObject,
      });
    }
  };
  add('path', route.schemas.params);
  add('query', route.schemas.query);
  // Path parameters without schema (none today) are still declared: OpenAPI requires them.
  for (const match of route.path.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)) {
    const name = match[1] as string;
    if (!result.some((p) => p.in === 'path' && p.name === name)) {
      result.push({ in: 'path', name, required: true, schema: { type: 'string' } });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------------------------

/** Roles holding `permission` and whether it is grantable to machine accesses. */
function permissionHolders(permission: RequiredPermission) {
  if (permission === 'public') return undefined;
  if (permission === 'authenticated') return { roles: [...ROLES], machineAccess: true };
  return {
    roles: ROLES.filter((role) => ROLE_PERMISSIONS[role].includes(permission)),
    machineAccess: GRANTABLE_MACHINE_PERMISSIONS.includes(permission as Permission),
  };
}

function permissionText(permission: RequiredPermission): string {
  if (permission === 'public') return 'Public: no authentication.';
  if (permission === 'authenticated') return 'Requires any authenticated principal.';
  return `Requires permission \`${permission}\`.`;
}

function operation(route: Route, doc: OperationDoc): ZodOpenApiOperationObject {
  const body = doc.body ?? route.schemas.body;
  const success: Record<number, ZodOpenApiResponseObject> = {};
  for (const response of doc.responses) {
    const schema =
      response.schema === undefined
        ? undefined
        : response.alternative === undefined
          ? ref(response.schema)
          : { oneOf: [ref(response.schema), ref(response.alternative)] };
    success[response.status] = {
      description: response.description,
      ...(schema !== undefined && { content: jsonContent(schema) }),
    };
  }
  const holders = permissionHolders(doc.permission);
  const params = parameters(route);
  return {
    operationId: doc.operationId,
    summary: doc.summary,
    description: [doc.description, permissionText(doc.permission)].filter(Boolean).join(' '),
    tags: [doc.tag],
    'x-required-permission': doc.permission,
    ...(holders !== undefined && { 'x-permission-holders': holders }),
    ...(doc.permission === 'public' && { security: [] }),
    ...(params.length > 0 && { parameters: params }),
    ...(body !== undefined && {
      requestBody: { required: true, content: { 'application/json': { schema: body } } },
    }),
    responses: { ...success, ...errorResponses(doc, route) },
  };
}

/**
 * Builds the document for `routes` (all registered routes of the Lambda). Throws
 * {@link UndocumentedRouteError} if a route has no catalog entry, so a new route cannot ship
 * without documentation.
 */
export function buildManagementOpenApiDocument(
  routes: readonly Route[],
): ManagementOpenApiDocument {
  const missing = routes.filter((route) => OPERATIONS[routeKey(route)] === undefined);
  if (missing.length > 0) throw new UndocumentedRouteError(missing.map(routeKey));

  const paths: ZodOpenApiPathsObject = {};
  for (const route of routes) {
    const doc = OPERATIONS[routeKey(route)] as OperationDoc;
    const item = (paths[route.path] ??= {});
    item[route.method.toLowerCase() as 'get'] = operation(route, doc);
  }

  const doc = createDocument(
    {
      openapi: '3.1.0',
      info: {
        title: MANAGEMENT_API_TITLE,
        version: MANAGEMENT_API_VERSION,
        description:
          'Agency portal and Admin_Modus operations for developers. Authenticate with ' +
          '`Authorization: Bearer <access token>` (portal users) or ' +
          '`Authorization: Bearer oem_<keyId>_<secret>` (machine access). `x-required-permission` ' +
          'names the permission of each operation; errors use the ErrorResponse format with the ' +
          'codes of ErrorCode.',
      },
      servers: [{ url: '/v1' }],
      security: [{ bearer: [] }],
      paths,
      components: {
        securitySchemes: {
          bearer: {
            type: 'http',
            scheme: 'bearer',
            description: 'Cognito access token of a portal user or machine-access credential.',
          },
        },
        schemas: componentSchemas(),
      },
    },
    { override: requestSchemaOverride },
  );
  dropUnusedOutputVariants(doc);
  return doc;
}

/** Same as the Search_API document: unreferenced `<Name>Output` variants are dropped. */
function dropUnusedOutputVariants(doc: ManagementOpenApiDocument): void {
  const components = doc.components;
  const schemas = components?.schemas;
  if (components === undefined || schemas === undefined) return;
  const serialized = JSON.stringify(doc);
  const unused = (name: string) =>
    name.endsWith('Output') &&
    name.slice(0, -'Output'.length) in schemas &&
    !serialized.includes(`"#/components/schemas/${name}"`);
  components.schemas = Object.fromEntries(
    Object.entries(schemas).filter(([name]) => !unused(name)),
  );
}
