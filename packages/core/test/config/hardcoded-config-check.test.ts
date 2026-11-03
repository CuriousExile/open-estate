import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

// Req 11.1: runs scripts/check-hardcoded-config.mjs in a child process (ESM script, CJS Jest).
const ROOT = join(__dirname, '..', '..', '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'check-hardcoded-config.mjs');

interface Finding {
  file: string;
  line: number;
  rule: string;
  match: string;
}

function check(args: string[] = []): Finding[] {
  try {
    return JSON.parse(
      execFileSync(process.execPath, [SCRIPT, '--json', ...args], { cwd: ROOT }).toString(),
    ) as Finding[];
  } catch (error) {
    // Exit code 1 = findings; the JSON is still on stdout.
    const stdout = (error as { stdout?: Buffer }).stdout?.toString() ?? '';
    if (stdout === '') throw error;
    return JSON.parse(stdout) as Finding[];
  }
}

const rules = (findings: Finding[]): { line: number; rule: string }[] =>
  findings.map(({ line, rule }) => ({ line, rule }));

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'oe-config-check-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fixture(name: string, lines: string[]): string {
  const path = join(dir, name);
  writeFileSync(path, lines.join('\n') + '\n');
  return path;
}

// Assembled at runtime so this test file itself contains no secret-shaped literal.
const AKIA = 'AKIA' + 'ABCDEFGHIJKLMNOP';
const GH_TOKEN = 'ghp_' + 'a'.repeat(36);
const PEM = '-----BEGIN ' + 'RSA PRIVATE KEY-----';
const ACCOUNT_ARN = 'arn:aws:iam::' + '123456789012' + ':role/x';

describe('static check for hard-coded configuration (Req 11.1)', () => {
  it('finds no hard-coded configuration in the production sources', () => {
    expect(check()).toEqual([]);
  });

  it('reports endpoints, ARNs, regions, resource names, IPs, URLs and secrets in runtime code', () => {
    const file = fixture('bad-runtime.ts', [
      `const a = 'https://abc123.execute-api.eu-central-1.amazonaws.com/prod';`,
      `const b = 'arn:aws:dynamodb:*:*:table/Listings';`,
      `const c = { TableName: 'Listings' };`,
      `const d = 'http://10.0.0.12:9200';`,
      `const e = \`https://partner-feed.de/api/\${id}\`;`,
      `const f = '${AKIA}';`,
      `const g = { apiToken: 'hunter2-abc' };`,
      `// ${GH_TOKEN}`,
      `const h = 'abc.cloudfront.net';`,
      `const i = '${PEM}';`,
      `const j = { password: 'swordfish' };`,
      `const k = '${ACCOUNT_ARN}';`,
    ]);

    expect(rules(check(['--profile', 'runtime', file]))).toEqual([
      { line: 1, rule: 'aws-endpoint' },
      { line: 1, rule: 'aws-region' },
      { line: 1, rule: 'hardcoded-url' },
      { line: 2, rule: 'aws-arn' },
      { line: 3, rule: 'resource-name' },
      { line: 4, rule: 'insecure-url' },
      { line: 4, rule: 'ip-address' },
      { line: 5, rule: 'hardcoded-url' },
      { line: 6, rule: 'secret-aws-access-key' },
      { line: 7, rule: 'secret-literal' },
      { line: 8, rule: 'secret-token' },
      { line: 9, rule: 'aws-endpoint' },
      { line: 10, rule: 'secret-private-key' },
      { line: 11, rule: 'secret-literal' },
      { line: 11, rule: 'secret-password' },
      { line: 12, rule: 'aws-account-id' },
      { line: 12, rule: 'aws-arn' },
    ]);
  });

  it('accepts env var names, configured values, placeholders and doc comments', () => {
    const file = fixture('ok-runtime.ts', [
      `/** Endpoint, e.g. \`https://<id>.eu-central-1.aoss.amazonaws.com\` or http://10.0.0.1. */`,
      `export const TABLE_ENV = 'LISTINGS_TABLE_NAME';`,
      `const a = { TableName: this.tableName, IndexName: 'byCity' };`,
      `const b = \`https://\${host}\`;`,
      `const c = 'https://mcp.invalid/mcp';`,
      `const d = ['https://example.org/x', 'https://api.example.com', 'https://partner.example'];`,
      `const e = 'http://localhost:4200';`,
      `const f = 'http://www.w3.org/2000/svg';`,
      `const g = { pageToken: 'nextPageToken of the previous page.', apiKey: '' };`,
      `const h = 'execute-api';`,
      `const i = 'version 1.2.3';`,
    ]);

    expect(check(['--profile', 'runtime', file])).toEqual([]);
  });

  it('allows resource definitions in infra but still forbids secrets, regions and account IDs', () => {
    const file = fixture('infra.ts', [
      `new ServicePrincipal('scheduler.amazonaws.com');`,
      `const a = { tableName: 'Listings', resource: 'arn:aws:execute-api:*:*:*' };`,
      `const b = { region: 'eu-west-1' };`,
      `const c = '${ACCOUNT_ARN}';`,
      `const d = '${AKIA}';`,
    ]);

    expect(rules(check(['--profile', 'infra', file]))).toEqual([
      { line: 3, rule: 'aws-region' },
      { line: 4, rule: 'aws-account-id' },
      { line: 5, rule: 'secret-aws-access-key' },
    ]);
  });

  it('honours inline ignores only when they give a reason', () => {
    const file = fixture('ignored.ts', [
      `const a = 'https://partner-feed.de'; // config-check-ignore: documented public default`,
      `// config-check-ignore: placeholder in an error message`,
      `const b = 'https://host.de';`,
      `const c = 'https://partner-feed.de'; // config-check-ignore:`,
    ]);

    expect(rules(check(['--profile', 'runtime', file]))).toEqual([
      { line: 4, rule: 'hardcoded-url' },
    ]);
  });

  it('suppresses allowlisted findings and reports stale allowlist entries', () => {
    const file = fixture('allowlisted.ts', [`const a = 'https://partner-feed.de/x';`]);
    const rel = relative(ROOT, file).split('\\').join('/');
    const allowlist = join(dir, 'allowlist.json');
    writeFileSync(
      allowlist,
      JSON.stringify([
        { file: rel, rule: 'hardcoded-url', match: 'https://partner-feed.de', reason: 'test' },
        { file: rel, rule: 'aws-region', match: 'eu-west-1', reason: 'test' },
      ]),
    );

    expect(rules(check(['--profile', 'runtime', '--allowlist', allowlist, file]))).toEqual([
      { line: 0, rule: 'stale-allowlist-entry' },
    ]);
  });
});
