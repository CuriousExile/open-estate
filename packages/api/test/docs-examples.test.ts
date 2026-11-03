import { LISTINGS_ROUTES, type ListingsHandler } from '@open-estate/api';
import { ERROR_CODES, ERROR_HTTP_STATUS } from '@open-estate/shared';
import {
  blocksByName,
  docApiHandler,
  docReadModel,
  DOC_VARS,
  exampleOptions,
  parseCurl,
  parseHead,
  readDoc,
  taggedBlocks,
  toListingsRequest,
  type TaggedBlock,
} from './support/docs-examples';

// docs/api.md must not drift from the code (Req 3.6, 10.5): every `request:<name>` curl example is
// sent to the real handlers and must produce exactly the documented `head:<name>` (status and
// headers) and `response:<name>` (JSON body; `excerpt` = documented fields only).

const DOC = readDoc('api.md');
const blocks = taggedBlocks(DOC);
const requests = blocksByName(blocks, 'request');
const heads = blocksByName(blocks, 'head');
const responses = blocksByName(blocks, 'response');

async function run(block: TaggedBlock) {
  const { mode, repeat } = exampleOptions(block.flags);
  const handler: ListingsHandler = docApiHandler(docReadModel(mode));
  const request = toListingsRequest(parseCurl(block.content, DOC_VARS));
  let response = await handler(request);
  for (let i = 1; i < repeat; i++) response = await handler(request);
  return { request, response };
}

function documentedBody(name: string): { body: unknown; excerpt: boolean } | undefined {
  const block = responses.get(name);
  if (block === undefined) return undefined;
  return { body: JSON.parse(block.content) as unknown, excerpt: block.flags.includes('excerpt') };
}

describe('docs/api.md examples', () => {
  it('pairs every request with its documented status and headers', () => {
    expect(requests.size).toBeGreaterThan(0);
    for (const name of [...heads.keys(), ...responses.keys()]) {
      expect(requests.has(name) ? name : `${name} (no request)`).toBe(name);
    }
    for (const name of requests.keys()) {
      expect(heads.has(name) ? name : `${name} (no head)`).toBe(name);
    }
  });

  it.each([...requests.keys()])('%s matches the handler output', async (name) => {
    const { response } = await run(requests.get(name) as TaggedBlock);
    const head = parseHead((heads.get(name) as TaggedBlock).content);
    const documented = documentedBody(name);

    expect({ statusCode: response.statusCode, headers: response.headers }).toEqual(head);
    if (documented === undefined) {
      expect(response.body).toBe('');
    } else if (documented.excerpt) {
      expect(JSON.parse(response.body)).toMatchObject(documented.body as object);
    } else {
      expect(JSON.parse(response.body)).toEqual(documented.body);
    }
  });

  it('has a successful example per endpoint (Req 3.6)', async () => {
    const covered = new Set<string>();
    for (const block of requests.values()) {
      const { request, response } = await run(block);
      if (response.statusCode === 200 && request.resource !== undefined) {
        covered.add(request.resource);
      }
    }
    expect([...covered].sort()).toEqual(Object.values(LISTINGS_ROUTES).sort());
  });

  it('shows a listing with SALE and RENT offer in search and detail examples', () => {
    const hasBoth = (listing: { offers: { offerType: string }[] }) =>
      ['SALE', 'RENT'].every((t) => listing.offers.some((o) => o.offerType === t));
    const search = documentedBody('search')?.body as {
      items: { offers: { offerType: string }[] }[];
    };
    const detail = documentedBody('detail')?.body as { offers: { offerType: string }[] };
    expect(search.items.some(hasBoth)).toBe(true);
    expect(hasBoth(detail)).toBe(true);
  });

  it('documents every error code with its HTTP status', () => {
    const rows = new Map(
      [...DOC.matchAll(/^\| `([A-Z_]+)` +\| (\d{3}|—) +\|/gm)].map(([, code, status]) => [
        code,
        status,
      ]),
    );
    expect([...rows.keys()].sort()).toEqual([...ERROR_CODES].sort());
    for (const [code, status] of Object.entries(ERROR_HTTP_STATUS)) {
      expect([code, rows.get(code)]).toEqual([code, String(status)]);
    }
    expect(rows.get('UNKNOWN_TOOL')).toBe('—');
  });

  it('documents exactly the search parameters of the request schema', () => {
    const section = DOC.slice(DOC.indexOf('## `GET /listings`'), DOC.indexOf('Filter rules:'));
    const documented = [...section.matchAll(/^\| `(\w+)` +\|/gm)].map(([, name]) => name);
    const schema = Object.keys(docReadModel().schemas.searchQuery.shape);
    expect(documented.sort()).toEqual(schema.sort());
  });
});
