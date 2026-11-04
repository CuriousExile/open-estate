#!/usr/bin/env node
// Template lint for Req 13.2: no visible literal text in component templates — every visible text
// must come from a Transloco key (`| transloco`) or from data. Parses inline `template:` strings and
// `templateUrl` files with Angular's own template parser.
//
// Usage: node scripts/check-template-i18n.mjs [--json] [file.ts|file.html ...]
// Without files, all components under src/ are checked. Exit code 1 if findings exist.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BindingPipe,
  Conditional,
  Interpolation,
  LiteralPrimitive,
  parseTemplate,
  TmplAstRecursiveVisitor,
  tmplAstVisitAll,
} from '@angular/compiler';
import ts from 'typescript';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Attributes whose value is shown to (or read out for) users. */
const VISIBLE_ATTRIBUTES = new Set([
  'alt',
  'title',
  'placeholder',
  'label',
  'aria-label',
  'aria-description',
  'aria-roledescription',
  'aria-placeholder',
  'aria-valuetext',
]);

/** Elements whose content is not visible text. */
const SKIPPED_ELEMENTS = new Set(['style', 'script']);

/** Literal texts that may appear untranslated (brand names, symbols). Keep short and justified. */
const ALLOWLIST = new Set([]);

/** Text that contains no letter (whitespace, punctuation, digits, symbols) is not language text. */
function isLanguageText(text) {
  const trimmed = text.trim();
  return /\p{L}/u.test(trimmed) && !ALLOWLIST.has(trimmed);
}

/** Literal strings of an expression that end up visible, i.e. are not translated by a pipe. */
function untranslatedLiterals(ast, found = []) {
  if (ast === null || ast === undefined) return found;
  if (ast.ast !== undefined) return untranslatedLiterals(ast.ast, found); // ASTWithSource
  if (ast instanceof BindingPipe) return found; // `'key' | transloco`, `x | codeLabel | transloco`
  if (ast instanceof LiteralPrimitive) {
    if (typeof ast.value === 'string' && isLanguageText(ast.value)) found.push(ast.value);
    return found;
  }
  if (ast instanceof Interpolation) {
    for (const s of ast.strings) if (isLanguageText(s)) found.push(s);
    for (const e of ast.expressions) untranslatedLiterals(e, found);
    return found;
  }
  if (ast instanceof Conditional) {
    // The condition itself is not shown; only the branches are.
    untranslatedLiterals(ast.trueExp, found);
    untranslatedLiterals(ast.falseExp, found);
    return found;
  }
  if (ast.left !== undefined && ast.right !== undefined) {
    // String concatenation: a literal part is visible.
    untranslatedLiterals(ast.left, found);
    untranslatedLiterals(ast.right, found);
  }
  return found;
}

class VisibleTextVisitor extends TmplAstRecursiveVisitor {
  findings = [];

  constructor(file, offset) {
    super();
    this.file = file;
    this.offset = offset;
  }

  report(node, kind, text) {
    const start = node.sourceSpan.start;
    this.findings.push({
      file: this.file,
      line: start.line + 1 + this.offset,
      kind,
      text: text.trim(),
    });
  }

  visitElement(element) {
    if (SKIPPED_ELEMENTS.has(element.name.toLowerCase())) return;
    super.visitElement(element);
  }

  visitText(text) {
    if (isLanguageText(text.value)) this.report(text, 'text', text.value);
  }

  visitBoundText(text) {
    for (const literal of untranslatedLiterals(text.value)) this.report(text, 'text', literal);
  }

  visitTextAttribute(attribute) {
    if (VISIBLE_ATTRIBUTES.has(attribute.name) && isLanguageText(attribute.value)) {
      this.report(attribute, `attribute ${attribute.name}`, attribute.value);
    }
  }

  visitBoundAttribute(attribute) {
    if (!VISIBLE_ATTRIBUTES.has(attribute.name)) return;
    for (const literal of untranslatedLiterals(attribute.value)) {
      this.report(attribute, `attribute ${attribute.name}`, literal);
    }
  }
}

/** Checks one template; `offset` maps template lines to lines of the containing file. */
function checkTemplate(template, file, offset = 0) {
  const parsed = parseTemplate(template, file, { preserveWhitespaces: true });
  if (parsed.errors?.length) {
    return parsed.errors.map((error) => ({
      file,
      line: error.span.start.line + 1 + offset,
      kind: 'parse error',
      text: error.msg,
    }));
  }
  const visitor = new VisibleTextVisitor(file, offset);
  tmplAstVisitAll(visitor, parsed.nodes);
  return visitor.findings;
}

/** Inline templates and `templateUrl` files of all `@Component` decorators in a TypeScript file. */
function componentTemplates(file) {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const templates = [];
  const visit = (node) => {
    if (
      ts.isDecorator(node) &&
      ts.isCallExpression(node.expression) &&
      node.expression.expression.getText(source) === 'Component'
    ) {
      const [options] = node.expression.arguments;
      for (const property of options && ts.isObjectLiteralExpression(options)
        ? options.properties
        : []) {
        if (!ts.isPropertyAssignment(property) || !ts.isStringLiteralLike(property.initializer)) {
          continue;
        }
        const name = property.name.getText(source);
        if (name === 'template') {
          const literal = property.initializer;
          // +1: skip the opening quote/backtick, which sits on the same line as the content start.
          const { line } = source.getLineAndCharacterOfPosition(literal.getStart(source) + 1);
          templates.push({ template: literal.text, file, offset: line });
        } else if (name === 'templateUrl') {
          const html = resolve(dirname(file), property.initializer.text);
          templates.push({ template: readFileSync(html, 'utf8'), file: html, offset: 0 });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return templates;
}

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') ? [path] : [];
  });
}

/** Findings of all given files (component `.ts` or template `.html`). */
function checkFiles(files) {
  return files.flatMap((file) =>
    file.endsWith('.html')
      ? checkTemplate(readFileSync(file, 'utf8'), file)
      : componentTemplates(file).flatMap((t) => checkTemplate(t.template, t.file, t.offset)),
  );
}

const args = process.argv.slice(2);
const json = args.includes('--json');
const files = args.filter((arg) => arg !== '--json').map((arg) => resolve(arg));
const findings = checkFiles(files.length > 0 ? files : sourceFiles(join(ROOT, 'src')));

if (json) {
  process.stdout.write(JSON.stringify(findings));
} else {
  for (const f of findings) {
    console.error(
      `${relative(process.cwd(), f.file)}:${f.line}: untranslated ${f.kind}: "${f.text}"`,
    );
  }
  if (findings.length > 0) {
    console.error(`${findings.length} visible text(s) without Transloco key (Req 13.2).`);
  }
}
process.exitCode = findings.length > 0 ? 1 : 0;
