#!/usr/bin/env node
// Static check for Req 11.1: environment- and source-specific configuration (endpoints, credentials,
// table/bucket names, environment identifiers such as regions and account IDs) must come from an
// external configuration source, never from the source code.
//
// Scanned: production sources `packages/*/src/**/*.{ts,mts,cts,js,mjs,cjs}` (no tests, fixtures,
// generated files, declarations). Two profiles:
// - runtime (every package except infra): none of the rules below may match.
// - infra: CDK legitimately defines resources, service principals and ARN patterns, so the
//   endpoint/ARN/resource-name rules do not apply; secrets, account IDs, regions, IPs and plain
//   http:// URLs are still forbidden.
// Secret rules scan the whole text (comments included); all other rules scan string and template
// literals only, so doc comments with example URLs are fine.
//
// Exceptions: `// config-check-ignore: <reason>` on the finding's line or the line above, or an
// entry in scripts/config-check-allowlist.json (`file` relative to the repository root, `rule`,
// `match` substring, `reason`). Entries that match nothing are reported as stale.
//
// Usage: node scripts/check-hardcoded-config.mjs [--json] [--profile runtime|infra]
//          [--allowlist file.json] [file ...]
// Without files, the whole repository is scanned. Exit code 1 if findings exist.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_ALLOWLIST = join(ROOT, 'scripts', 'config-check-allowlist.json');

const SOURCE_FILE = /\.(ts|mts|cts|js|mjs|cjs)$/;
const EXCLUDED_FILE = /(\.d\.[mc]?ts|\.(test|spec)\.[mc]?[jt]s)$/;
const EXCLUDED_DIRS = new Set(['node_modules', 'dist', 'generated', 'fixtures', '__fixtures__']);
const INFRA_PACKAGE = `packages${sep}infra${sep}`;

/** Hosts reserved for documentation/tests (RFC 2606, RFC 6761) and loopback. */
const RESERVED_HOST =
  /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0|(.+\.)?example(\.(com|net|org))?|.+\.(test|invalid|localhost))$/i;
/** Namespace URIs are identifiers, not endpoints. */
const NAMESPACE_URI = /^http:\/\/www\.w3\.org\//;

const REGION =
  /\b(us|eu|ap|sa|ca|me|af|il|mx|cn)(-gov|-iso[a-z]?)?-(central|north|south|east|west|northeast|northwest|southeast|southwest)-\d\b/;

/** Property names whose string value is a deployment-specific resource name. */
const RESOURCE_NAME_PROPERTY =
  /^(TableName|tableName|Bucket|bucket|BucketName|bucketName|QueueUrl|queueUrl|TopicArn|topicArn|FunctionName|functionName|StateMachineArn|stateMachineArn|SecretId|secretId|Name|collectionName|indexName|endpoint|Endpoint|host|hostname)$/;
/** Variable/property names that would hold a credential. */
const SECRET_NAME =
  /(password|passwd|secret|token|api_?key|access_?key|credentials?|private_?key)$/i;
/** Pagination cursors are named `*Token` but are not credentials. */
const NOT_A_SECRET_NAME = /(page|next|continuation|cursor)_?token$/i;
/** Values that are env-var names (`LISTINGS_TABLE_NAME`) or empty, not values. */
const NOT_A_VALUE = /^([A-Z][A-Z0-9_]*|\s*)$/;

/** Rules applied to the full text, comments included. */
const TEXT_RULES = [
  {
    id: 'secret-private-key',
    message: 'private key block in source',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    id: 'secret-aws-access-key',
    message: 'AWS access key ID in source',
    pattern: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g,
  },
  {
    id: 'secret-aws-secret-key',
    message: 'AWS secret access key in source',
    pattern: /\b(aws_secret_access_key|secretAccessKey)\b\s*[:=]\s*['"`][^'"`\s]{8,}/gi,
  },
  {
    id: 'secret-token',
    message: 'access token (GitHub/Slack/JWT/Bearer) in source',
    pattern:
      /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}|xox[abposr]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})|\bBearer\s+[A-Za-z0-9\-._~+/]{20,}=*/g,
  },
  {
    id: 'secret-password',
    message: 'password literal in source',
    pattern: /\b(password|passwd|pwd)\s*[:=]\s*['"][^'"\s]{3,}['"]/gi,
  },
  {
    id: 'aws-account-id',
    message: 'AWS account ID in source; derive it from the deployment environment',
    pattern: /\barn:aws[a-z-]*:[a-z0-9-]*:[a-z0-9-]*:\d{12}:|\b\d{12}\.dkr\.ecr\./g,
  },
];

/** Rules applied to the text of string and template literals. `infra: true` = also for infra. */
const LITERAL_RULES = [
  {
    id: 'aws-endpoint',
    message: 'AWS service endpoint in runtime code; read it from configuration',
    pattern:
      /[a-z0-9-]+\.(execute-api\.|aoss\.|lambda-url\.)?[a-z0-9-]*\.?amazonaws\.com(\.cn)?\b|[a-z0-9]+\.cloudfront\.net\b/gi,
  },
  {
    id: 'aws-arn',
    message: 'ARN in runtime code; read it from configuration',
    pattern: /\barn:aws[a-z-]*:[a-z0-9-]+:/g,
  },
  {
    id: 'aws-region',
    message: 'AWS region in source; use AWS_REGION or the deployment context',
    pattern: new RegExp(REGION.source, 'g'),
    infra: true,
  },
  {
    id: 'ip-address',
    message: 'IP address in source; read it from configuration',
    pattern: /(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\d.])/g,
    accept: (m) => m.slice(1).every((n) => Number(n) <= 255) && !/^(127\.|0\.0\.0\.0)/.test(m[0]),
    infra: true,
  },
  {
    id: 'insecure-url',
    message: 'plain http:// URL in source; use https or configuration',
    pattern: /\bhttp:\/\/[^\s'"`<>()]+/g,
    accept: (m) => !NAMESPACE_URI.test(m[0]) && !RESERVED_HOST.test(hostOf(m[0])),
    infra: true,
  },
  {
    id: 'hardcoded-url',
    message: 'absolute URL in runtime code; data source endpoints belong in configuration',
    pattern: /\bhttps:\/\/[^\s'"`<>()]+/g,
    accept: (m) => hostOf(m[0]) !== '' && !RESERVED_HOST.test(hostOf(m[0])),
  },
];

function hostOf(url) {
  const match = /^[a-z]+:\/\/([^/?#:]*|\[[^\]]*\])/i.exec(url);
  return match ? match[1] : '';
}

// --- file discovery -------------------------------------------------------------------------

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name)) walk(path, out);
    } else if (SOURCE_FILE.test(entry.name) && !EXCLUDED_FILE.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

function repositorySources() {
  const packages = join(ROOT, 'packages');
  return readdirSync(packages, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const src = join(packages, entry.name, 'src');
      try {
        return walk(src, []);
      } catch {
        return []; // package without src/
      }
    })
    .sort();
}

const profileOf = (file) => (relative(ROOT, file).startsWith(INFRA_PACKAGE) ? 'infra' : 'runtime');

// --- scanning -------------------------------------------------------------------------------

function lineAt(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/** String/template literal fragments with their start offset (of the literal content). */
function literalsOf(source) {
  const out = [];
  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      out.push({ text: node.text, start: node.getStart(source) + 1 });
    } else if (ts.isTemplateExpression(node)) {
      out.push({ text: node.head.text, start: node.head.getStart(source) + 1 });
      for (const span of node.templateSpans) {
        out.push({ text: span.literal.text, start: span.literal.getStart(source) + 1 });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

const isStringValue = (node) =>
  node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node));

/** `{ TableName: 'Listings' }`, `const apiToken = 'abc'` and alike. */
function namedValuesOf(source) {
  const out = [];
  const visit = (node) => {
    let name;
    let value;
    if (ts.isPropertyAssignment(node) || ts.isPropertyDeclaration(node)) {
      name = node.name;
      value = node.initializer;
    } else if (ts.isVariableDeclaration(node) || ts.isParameter(node)) {
      name = node.name;
      value = node.initializer;
    }
    if (
      name !== undefined &&
      isStringValue(value) &&
      (ts.isIdentifier(name) || ts.isStringLiteral(name))
    ) {
      out.push({ name: name.text, value: value.text, start: value.getStart(source) });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

function scriptKind(file) {
  if (/\.[mc]?js$/.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

export function scanText(file, text, profile) {
  const findings = [];
  const add = (rule, message, index, match) =>
    findings.push({ file, line: lineAt(text, index), rule, message, match });

  for (const rule of TEXT_RULES) {
    for (const m of text.matchAll(rule.pattern)) add(rule.id, rule.message, m.index, m[0]);
  }

  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
  for (const literal of literalsOf(source)) {
    for (const rule of LITERAL_RULES) {
      if (profile === 'infra' && !rule.infra) continue;
      for (const m of literal.text.matchAll(rule.pattern)) {
        if (rule.accept && !rule.accept(m)) continue;
        // Offsets inside a literal are exact unless escapes precede the match; the line stays right.
        add(rule.id, rule.message, literal.start + m.index, m[0]);
      }
    }
  }

  for (const { name, value, start } of namedValuesOf(source)) {
    if (NOT_A_VALUE.test(value)) continue;
    if (profile === 'runtime' && RESOURCE_NAME_PROPERTY.test(name) && !value.startsWith('/')) {
      add(
        'resource-name',
        `literal "${name}" in runtime code; read it from configuration`,
        start,
        value,
      );
    }
    if (SECRET_NAME.test(name) && !NOT_A_SECRET_NAME.test(name)) {
      add(
        'secret-literal',
        `literal assigned to "${name}"; credentials belong in Secrets Manager`,
        start,
        value,
      );
    }
  }

  // De-duplicate (a literal may hit several overlapping patterns of the same rule).
  const seen = new Set();
  return findings
    .filter((f) => {
      const key = `${f.line}\0${f.rule}\0${f.match}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
}

// --- exceptions -----------------------------------------------------------------------------

const IGNORE = /config-check-ignore:(.*)$/;

function inlineIgnored(lines, line) {
  for (const candidate of [lines[line - 1], lines[line - 2]]) {
    const m = candidate === undefined ? null : IGNORE.exec(candidate);
    if (m && m[1].replace(/\*\/.*$/, '').trim() !== '') return true;
  }
  return false;
}

function loadAllowlist(path) {
  const entries = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(entries)) throw new Error(`${path}: expected an array`);
  for (const [i, e] of entries.entries()) {
    for (const key of ['file', 'rule', 'match', 'reason']) {
      if (typeof e[key] !== 'string' || e[key].trim() === '') {
        throw new Error(`${path}[${i}]: "${key}" must be a non-empty string`);
      }
    }
  }
  return entries.map((e) => ({ ...e, used: false }));
}

export function check(files, { profile, allowlist } = {}) {
  const entries = allowlist ? loadAllowlist(allowlist) : [];
  const findings = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n');
    const rel = relative(ROOT, file).split(sep).join('/');
    for (const finding of scanText(file, text, profile ?? profileOf(file))) {
      if (inlineIgnored(lines, finding.line)) continue;
      const entry = entries.find(
        (e) => e.file === rel && e.rule === finding.rule && finding.match.includes(e.match),
      );
      if (entry) {
        entry.used = true;
        continue;
      }
      findings.push(finding);
    }
  }
  return { findings, stale: entries.filter((e) => !e.used) };
}

// --- CLI ------------------------------------------------------------------------------------

function main(argv) {
  const json = argv.includes('--json');
  const option = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  const profile = option('--profile');
  const allowlistArg = option('--allowlist');
  const valued = new Set([argv.indexOf('--profile') + 1, argv.indexOf('--allowlist') + 1]);
  const files = argv.filter((a, i) => !a.startsWith('--') && !valued.has(i)).map((f) => resolve(f));
  if (profile !== undefined && profile !== 'runtime' && profile !== 'infra') {
    throw new Error(`--profile must be runtime or infra, got ${profile}`);
  }

  const fullScan = files.length === 0;
  const allowlist = allowlistArg ?? (fullScan ? DEFAULT_ALLOWLIST : undefined);
  const { findings, stale } = check(fullScan ? repositorySources() : files, { profile, allowlist });
  // Stale entries only make sense when every file was scanned (or the allowlist was given).
  const staleFindings =
    fullScan || allowlistArg !== undefined
      ? stale.map((e) => ({
          file: allowlist,
          line: 0,
          rule: 'stale-allowlist-entry',
          message: `allowlist entry matches nothing: ${e.file} ${e.rule} "${e.match}"`,
          match: e.match,
        }))
      : [];
  const all = [...findings, ...staleFindings];

  if (json) {
    process.stdout.write(JSON.stringify(all, null, 2) + '\n');
  } else {
    for (const f of all) {
      process.stdout.write(
        `${relative(ROOT, f.file)}:${f.line}: [${f.rule}] ${f.message} (${f.match})\n`,
      );
    }
    if (all.length === 0) process.stdout.write('check-hardcoded-config: no findings\n');
  }
  process.exitCode = all.length > 0 ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
