import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Req 13.2: runs scripts/check-template-i18n.mjs in a child process — Angular's template parser is
// ESM-only and cannot be loaded by Jest's CommonJS runtime.
const FRONTEND = join(__dirname, '..');
const SCRIPT = join(FRONTEND, 'scripts', 'check-template-i18n.mjs');

interface Finding {
  file: string;
  line: number;
  kind: string;
  text: string;
}

function lint(files: string[] = []): Finding[] {
  try {
    return JSON.parse(
      execFileSync(process.execPath, [SCRIPT, '--json', ...files], { cwd: FRONTEND }).toString(),
    ) as Finding[];
  } catch (error) {
    // Exit code 1 = findings; the JSON is still on stdout.
    const stdout = (error as { stdout?: Buffer }).stdout?.toString() ?? '';
    if (stdout === '') throw error;
    return JSON.parse(stdout) as Finding[];
  }
}

const component = (template: string): string =>
  `import { Component } from '@angular/core';\n@Component({\n  selector: 'oe-x',\n  template: \`${template}\`,\n})\nexport class X {}\n`;

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'oe-template-lint-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function fixture(name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

describe('template lint for visible text without Transloco key (Req 13.2)', () => {
  it('finds no untranslated visible text in the component templates', () => {
    expect(lint()).toEqual([]);
  });

  it('accepts translated text, interpolated data, punctuation and non-visible attributes', () => {
    const file = fixture(
      'ok.component.ts',
      component(`
        <h1>{{ 'home.title' | transloco }}</h1>
        <p>({{ count }}) – {{ row.title }}: {{ price }} € / 100 %</p>
        <img [src]="url" alt="" [attr.aria-label]="'a.b' | transloco" />
        <input id="search-city" type="text" autocomplete="off" inputmode="decimal"
          [placeholder]="(first ? 'p.min' : 'p.max') | transloco" />
        <svg aria-hidden="true"><path d="m20 20-4-4" stroke="currentColor" /></svg>
        <span [id]="'search-' + name">{{ type | codeLabel: 'offerType' | transloco }}</span>
      `),
    );

    expect(lint([file])).toEqual([]);
  });

  it('reports literal text nodes, attributes, bound literals and text around interpolations', () => {
    const file = fixture(
      'bad.component.ts',
      component(`<h1>Search</h1>
        <img src="x.png" alt="House photo" />
        <input placeholder="City" />
        <button [attr.aria-label]="'Close'" [title]="open ? 'Open' : ('k' | transloco)">x</button>
        <p>Price: {{ price }}</p>
        <p>{{ 'Literal' }}</p>`),
    );

    expect(lint([file]).map(({ line, kind, text }) => ({ line, kind, text }))).toEqual([
      { line: 4, kind: 'text', text: 'Search' },
      { line: 5, kind: 'attribute alt', text: 'House photo' },
      { line: 6, kind: 'attribute placeholder', text: 'City' },
      { line: 7, kind: 'attribute aria-label', text: 'Close' },
      { line: 7, kind: 'attribute title', text: 'Open' },
      { line: 7, kind: 'text', text: 'x' },
      { line: 8, kind: 'text', text: 'Price:' },
      { line: 9, kind: 'text', text: 'Literal' },
    ]);
  });

  it('checks templateUrl files and .html templates', () => {
    fixture('page.html', '<p>Hello</p>\n');
    const file = fixture(
      'page.component.ts',
      `import { Component } from '@angular/core';\n@Component({ selector: 'oe-p', templateUrl: './page.html' })\nexport class P {}\n`,
    );

    expect(lint([file])).toEqual([
      { file: join(dir, 'page.html'), line: 1, kind: 'text', text: 'Hello' },
    ]);
  });

  it('detects a literal text injected into every real component template', () => {
    // Guards against the lint silently skipping a component (e.g. a changed decorator shape).
    const sources = readdirSync(join(FRONTEND, 'src', 'app'), { recursive: true, encoding: 'utf8' })
      .filter((path) => path.endsWith('.component.ts') || path === 'app.ts')
      .map((path) => join(FRONTEND, 'src', 'app', path));
    expect(sources.length).toBeGreaterThan(0);

    const mutated = sources.map((path, i) =>
      fixture(
        `mutated-${i}.ts`,
        readFileSync(path, 'utf8').replace(/template: `/, 'template: `<i>Untranslated</i>'),
      ),
    );

    expect(lint(mutated).map((finding) => finding.file)).toEqual(mutated);
  });
});
