import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildOpenApiDocument } from '@open-estate/api';
import { blocksByName, docReadModel, REPO_ROOT, taggedBlocks } from './support/docs-examples';

/**
 * Artefact checks for documentation and licence (task 20.5). The contents of the examples are
 * verified elsewhere: `docs-examples.test.ts` (API, MCP; every tool is called there),
 * `docs-example-connector.test.ts` (connector guide) and the frontend `theme-docs.test.ts`
 * (theme table). This suite checks that every required document exists on its own, is reachable
 * from the docs index and covers every required topic with an example.
 *
 * **Validates: Requirements 3.6, 8.6, 10.1, 10.3, 10.4, 10.5, 10.6**
 */

const read = (file: string): string => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');

/** Text from the heading line up to the next heading of the same or a higher level. */
function section(markdown: string, heading: string): string {
  const level = /^#+/.exec(heading)?.[0].length ?? 0;
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start < 0) return '';
  const next = lines.findIndex((line, i) => i > start && new RegExp(`^#{1,${level}} `).test(line));
  return lines.slice(start, next < 0 ? undefined : next).join('\n');
}

const hasCodeBlock = (text: string, lang = '\\w+'): boolean =>
  new RegExp(`^\`\`\`${lang}\\b`, 'm').test(text);

/** Separate guides (Req 10.5) and the repository documents linked from them. */
const GUIDES = [
  'docs/installation.md',
  'docs/api.md',
  'docs/mcp.md',
  'docs/connectors.md',
  'docs/configuration.md',
] as const;
const REPO_DOCS = ['README.md', 'docs/README.md', 'CONTRIBUTING.md', 'ROADMAP.md', 'LICENSE'];

describe('documentation artefacts', () => {
  it.each([...GUIDES, ...REPO_DOCS, 'packages/admin/README.md'])(
    '%s exists and is not empty',
    (file) => {
      expect(read(file).trim().length).toBeGreaterThan(200);
    },
  );

  it('links every guide from docs/README.md and the docs index from README.md', () => {
    const index = read('docs/README.md');
    for (const guide of GUIDES) {
      const link = `](${path.basename(guide)})`;
      expect(index.includes(link) ? guide : `${guide} not linked`).toBe(guide);
    }
    expect(read('README.md')).toContain('](docs/README.md)');
  });

  it('describes the installation with prerequisites, numbered steps and troubleshooting (Req 10.1)', () => {
    const doc = read('docs/installation.md');
    expect(section(doc, '## Prerequisites')).not.toBe('');
    const steps = section(doc, '## Deploy step by step');
    const numbers = [...steps.matchAll(/^(\d+)\. /gm)].map(([, n]) => Number(n));
    expect(numbers.length).toBeGreaterThanOrEqual(3);
    expect(numbers).toEqual(numbers.map((_, i) => i + 1));
    expect(steps).toMatch(/cdk.*deploy|npm run deploy/);
    expect(section(doc, '## Troubleshooting').match(/^### /gm)?.length).toBeGreaterThan(0);
  });

  it('describes interface, mandatory operations, registration and an example for connectors (Req 10.3)', () => {
    const doc = read('docs/connectors.md');
    expect(section(doc, '### Interface')).toMatch(/initialize\(.*run\(.*reportStatus\(/s);
    for (const op of ['initialize(ctx)', 'run(ctx)', 'reportStatus()']) {
      expect(section(doc, '### Mandatory operations')).toContain(`\`${op}\``);
    }
    expect(hasCodeBlock(section(doc, '### Registering the module (code)'), 'ts')).toBe(true);
    expect(
      hasCodeBlock(section(doc, '### Registering the connector (configuration)'), 'json'),
    ).toBe(true);
    expect(hasCodeBlock(section(doc, '### Complete example: `partner-feed`'), 'ts')).toBe(true);
  });

  it.each([
    ['docs/configuration.md', '## Theming'],
    ['docs/configuration.md', '## Translations & locales'],
    ['docs/configuration.md', '## Property taxonomy'],
    ['docs/configuration.md', '## 3D tour providers'],
    ['docs/mcp.md', '## Connecting an AI agent'],
  ])('%s "%s" has a configuration example (Req 8.6, 10.6)', (file, heading) => {
    expect(hasCodeBlock(section(read(file), heading), 'json')).toBe(true);
  });
});

describe('request and response example per endpoint (Req 3.6)', () => {
  const openapi = buildOpenApiDocument(docReadModel());
  const operations = Object.entries(openapi.paths ?? {}).flatMap(([route, item]) =>
    Object.keys(item ?? {})
      .filter((key) => ['get', 'post', 'put', 'patch', 'delete'].includes(key))
      .map((method) => `${method.toUpperCase()} ${route}`),
  );
  const api = read('docs/api.md');
  const mcp = read('docs/mcp.md');

  it('lists exactly the OpenAPI operations in the api.md overview', () => {
    const table = [...api.matchAll(/^\| `([A-Z]+)` +\| `(\/\S*)` +\|/gm)].map(
      ([, method, route]) => `${method} ${route}`,
    );
    expect(operations.length).toBeGreaterThan(0);
    expect(table.sort()).toEqual([...operations].sort());
  });

  it.each(operations.filter((op) => op !== 'POST /mcp'))(
    '%s has a tagged request and response example in api.md',
    (operation) => {
      const kinds = taggedBlocks(section(api, `## \`${operation}\``)).map((b) => b.kind);
      expect(kinds).toEqual(expect.arrayContaining(['request', 'response']));
    },
  );

  it('POST /mcp has an HTTP request and response example in mcp.md', () => {
    expect(operations).toContain('POST /mcp');
    const blocks = taggedBlocks(mcp);
    const responses = blocksByName(blocks, 'mcp-response');
    const curls = [...blocksByName(blocks, 'mcp-curl').keys()];
    expect(curls.filter((name) => responses.has(name)).length).toBeGreaterThan(0);
  });
});

describe('licence (Req 10.4)', () => {
  // Apache-2.0 is OSI-approved; the SPDX id must match the licence text and every package.json.
  const SPDX = 'Apache-2.0';

  it('ships the full Apache License 2.0 text as LICENSE', () => {
    const text = read('LICENSE');
    expect(text).toMatch(/^\s*Apache License\s+Version 2\.0, January 2004/);
    expect(text).toContain('TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION');
    expect(text).toContain('END OF TERMS AND CONDITIONS');
  });

  it('declares the same licence in the root and every workspace package.json', () => {
    const root = JSON.parse(read('package.json')) as { license?: string; workspaces: string[] };
    const declared = Object.fromEntries(
      ['.', ...root.workspaces].map((dir) => {
        const pkg = JSON.parse(read(path.join(dir, 'package.json'))) as { license?: string };
        return [dir, pkg.license];
      }),
    );
    expect(Object.values(declared).length).toBe(root.workspaces.length + 1);
    for (const [dir, license] of Object.entries(declared))
      expect([dir, license]).toEqual([dir, SPDX]);
  });
});
