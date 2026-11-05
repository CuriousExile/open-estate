import { createListingsRoutes, type ListingsRequest } from '@open-estate/api';
import { DOC_LISTINGS, docReadModel } from './support/docs-examples';

// `createListingsRoutes`: the router over an injected read model (used by `initListingsHandler`
// and by the local dev server).

const request = (resource: string, extra: Partial<ListingsRequest> = {}): ListingsRequest => ({
  httpMethod: 'GET',
  resource,
  requestContext: { identity: { sourceIp: '198.51.100.7' } },
  ...extra,
});

describe('createListingsRoutes', () => {
  const routes = createListingsRoutes(docReadModel());

  it('serves search, detail and discovery from the injected read model', async () => {
    const search = await routes(request('/listings'));
    expect(search.statusCode).toBe(200);
    expect((JSON.parse(search.body) as { items: unknown[] }).items).toHaveLength(
      DOC_LISTINGS.length,
    );

    const id = DOC_LISTINGS[0]?.id ?? '';
    const detail = await routes(request('/listings/{id}', { pathParameters: { id } }));
    expect(detail.statusCode).toBe(200);
    expect((JSON.parse(detail.body) as { id: string }).id).toBe(id);

    expect((await routes(request('/openapi.json'))).statusCode).toBe(200);
    expect((await routes(request('/meta'))).statusCode).toBe(200);
  });

  it('answers unknown resources with NOT_FOUND', async () => {
    const response = await routes(request('/nope'));
    expect(response.statusCode).toBe(404);
  });
});
