import { createMcpHandler, TOOL_NAMES, type McpRequest } from '@open-estate/mcp';
import {
  blocksByName,
  docReadModel,
  DOC_VARS,
  parseCurl,
  parseHead,
  readDoc,
  taggedBlocks,
  type TaggedBlock,
} from '../../api/test/support/docs-examples';

// docs/mcp.md must not drift from the code (Req 10.6): every `mcp-request:<name>` JSON-RPC body
// and every `mcp-curl:<name>` call is sent to the real MCP handler and must produce the documented
// `mcp-response:<name>` (`excerpt` = documented fields only) and, if given, `mcp-head:<name>`.

const blocks = taggedBlocks(readDoc('mcp.md'));
const requests = blocksByName(blocks, 'mcp-request');
const curls = blocksByName(blocks, 'mcp-curl');
const heads = blocksByName(blocks, 'mcp-head');
const responses = blocksByName(blocks, 'mcp-response');

const HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
};

async function post(event: Omit<McpRequest, 'requestContext'>) {
  const mcp = createMcpHandler(docReadModel());
  return mcp({ ...event, requestContext: { identity: { sourceIp: '203.0.113.7' } } });
}

function expectDocumented(
  name: string,
  response: { statusCode: number; headers?: unknown; body: string },
) {
  const head = heads.get(name);
  if (head !== undefined) {
    expect({ statusCode: response.statusCode, headers: response.headers }).toEqual(
      parseHead(head.content),
    );
  }
  const documented = responses.get(name) as TaggedBlock;
  const expected = JSON.parse(documented.content) as object;
  const actual = JSON.parse(response.body) as unknown;
  if (documented.flags.includes('excerpt')) expect(actual).toMatchObject(expected);
  else expect(actual).toEqual(expected);
  return actual;
}

describe('docs/mcp.md examples', () => {
  it('pairs every request with a documented response', () => {
    expect(requests.size).toBeGreaterThan(0);
    expect([...responses.keys()].sort()).toEqual([...requests.keys()].sort());
    for (const name of [...heads.keys(), ...curls.keys()]) {
      expect(requests.has(name) ? name : `${name} (no request)`).toBe(name);
    }
  });

  it.each([...requests.keys()])('%s matches the handler output', async (name) => {
    const body = (requests.get(name) as TaggedBlock).content;
    const response = await post({ httpMethod: 'POST', headers: HEADERS, body });

    const actual = expectDocumented(name, response) as {
      result?: { content?: { text?: string }[]; structuredContent?: unknown };
    };

    // Excerpts omit `content[0].text`: it must be the serialized `structuredContent`.
    const result = actual.result;
    if (result?.structuredContent !== undefined) {
      expect(JSON.parse(result.content?.[0]?.text ?? '')).toEqual(result.structuredContent);
    }
  });

  it.each([...curls.keys()])('curl %s matches the documented response', async (name) => {
    const curl = parseCurl((curls.get(name) as TaggedBlock).content, DOC_VARS);
    expect(curl.url.pathname.endsWith('/mcp')).toBe(true);
    const response = await post({
      httpMethod: curl.method,
      headers: curl.headers,
      body: curl.body ?? null,
    });
    expectDocumented(name, response);
  });

  it('calls every tool in the examples', () => {
    const called = [...requests.values()].flatMap((block) => {
      const message = JSON.parse(block.content) as { method?: string; params?: { name?: string } };
      return message.method === 'tools/call' ? [message.params?.name] : [];
    });
    expect(TOOL_NAMES.filter((tool) => !called.includes(tool))).toEqual([]);
  });

  it('answers GET with 405 as documented', async () => {
    const response = await post({ httpMethod: 'GET', headers: {} });
    expect(response.statusCode).toBe(405);
    expect(response.headers).toMatchObject({ Allow: 'POST' });
  });
});
