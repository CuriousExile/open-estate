#!/usr/bin/env node
// Renders the permission matrix of the Management API (Req 2.1) from `packages/shared/src/
// permissions.ts` into the generated region of docs/management-api.md. The table in
// `permissions.ts` is the single source; this script only formats it. The output is
// deterministic (row order = `PERMISSIONS`, column order = `ROLES` + machine access) and the
// document is formatted with the repository's Prettier config, so regenerating is stable.
//
// Reads the compiled `@open-estate/shared` (`dist/`); `npm run docs:permissions` builds it first.
//
// Usage: node scripts/generate-permission-matrix.mjs [--check]
//   --check  write nothing; exit code 1 if the document differs from the generated matrix.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as prettier from 'prettier';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DOC = join(ROOT, 'docs', 'management-api.md');
const BEGIN = '<!-- BEGIN GENERATED: permission-matrix -->';
const END = '<!-- END GENERATED: permission-matrix -->';

const require = createRequire(import.meta.url);
const {
  PERMISSIONS,
  ROLES,
  ROLE_PERMISSIONS,
  GRANTABLE_MACHINE_PERMISSIONS,
} = require('@open-estate/shared');

/** What each permission allows. Every permission must have exactly one entry. */
const DESCRIPTIONS = {
  'listing:read': 'Read listings, their version history and diffs',
  'listing:write': 'Create listings and replace their content and Custom_Id',
  'listing:status': 'Activate and deactivate listings',
  'version:restore': 'Restore the content of an earlier version',
  'monitoring:read': 'Agency monitoring: overview, connector runs, usage, metrics',
  'audit:read': 'Query the audit log',
  'member:manage': 'Add and remove members, change their roles',
  'machine-access:manage': 'Create, list and revoke machine accesses',
  'agency:manage': 'Create, rename, suspend and reactivate agencies; manage platform admins',
  'platform:operate':
    'Admin API functions under `/platform/*`: deletions, API keys, rate limits, access mode, reload',
  'monitoring:platform': 'Platform metrics, alarms, agency activity, history size',
  'listing:assign': 'Assign a listing to another agency',
};

const MACHINE_ACCESS = 'Machine access (grantable)';

function renderMatrix() {
  const missing = PERMISSIONS.filter((p) => DESCRIPTIONS[p] === undefined);
  const unknown = Object.keys(DESCRIPTIONS).filter((p) => !PERMISSIONS.includes(p));
  if (missing.length > 0 || unknown.length > 0) {
    throw new Error(
      `DESCRIPTIONS out of sync with PERMISSIONS: missing [${missing}], unknown [${unknown}]`,
    );
  }
  const columns = [
    ...ROLES.map((role) => ({ title: `\`${role}\``, grants: ROLE_PERMISSIONS[role] })),
    { title: MACHINE_ACCESS, grants: GRANTABLE_MACHINE_PERMISSIONS },
  ];
  const row = (cells) => `| ${cells.join(' | ')} |`;
  return [
    row(['Permission', 'Allows', ...columns.map((c) => c.title)]),
    row(['---', '---', ...columns.map(() => ':---:')]),
    ...PERMISSIONS.map((permission) =>
      row([
        `\`${permission}\``,
        DESCRIPTIONS[permission],
        ...columns.map((c) => (c.grants.includes(permission) ? '✓' : '–')),
      ]),
    ),
  ].join('\n');
}

async function main() {
  const check = process.argv.includes('--check');
  const current = readFileSync(DOC, 'utf8');
  const begin = current.indexOf(BEGIN);
  const end = current.indexOf(END);
  if (begin === -1 || end === -1 || end < begin) {
    throw new Error(`${relative(ROOT, DOC)}: markers ${BEGIN} … ${END} not found`);
  }
  const replaced =
    current.slice(0, begin + BEGIN.length) + `\n\n${renderMatrix()}\n\n` + current.slice(end);
  const options = (await prettier.resolveConfig(DOC)) ?? {};
  const next = await prettier.format(replaced, { ...options, filepath: DOC });

  if (check) {
    if (next !== current) {
      console.error(
        `${relative(ROOT, DOC)}: permission matrix is out of date; run npm run docs:permissions`,
      );
      process.exitCode = 1;
    }
    return;
  }
  if (next !== current) writeFileSync(DOC, next);
  console.log(
    `${relative(ROOT, DOC)}: permission matrix ${next === current ? 'unchanged' : 'updated'}`,
  );
}

await main();
