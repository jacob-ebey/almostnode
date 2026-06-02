/**
 * TypeScript type stripping (pure JS)
 *
 * Mirrors Node.js's native `.ts` support (type-stripping mode, stable since
 * Node 23.6): TypeScript-only syntax is replaced with whitespace, leaving the
 * runtime JavaScript and all source positions intact.
 *
 * Implemented on top of `acorn-typescript` (a pure-JS acorn plugin) — no
 * `typescript` compiler dependency and no wasm, so it stays small and runs
 * synchronously, which is required for `require()`.
 *
 * Like Node's strip-only mode, constructs that need code generation (enums,
 * namespaces with runtime members, parameter-property assignments) are not
 * emitted; we strip the type syntax best-effort.
 */

import * as acorn from 'acorn';
import { tsPlugin } from 'acorn-typescript';

// Build the TS-aware parser once.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const TsParser = (acorn.Parser as any).extend(tsPlugin({ allowSatisfies: true }));

// Node's native type-stripping supports .ts/.mts/.cts only — not .tsx (JSX).
// (.tsx is still handled separately by the Vite/Next dev servers via esbuild.)
const TS_EXTENSIONS = ['.ts', '.mts', '.cts'] as const;

/** Module resolution extensions to try for TypeScript files. */
export const TS_RESOLVE_EXTENSIONS = [...TS_EXTENSIONS];

/** Returns true if the filename is a TypeScript source file. */
export function isTypeScriptFile(filename: string): boolean {
  return /\.(ts|mts|cts)$/.test(filename);
}

/**
 * `.cts` is CommonJS TypeScript — like `.cjs`, it should not run the
 * ESM→CJS transform after stripping.
 */
export function isCommonJsTypeScriptFile(filename: string): boolean {
  return filename.endsWith('.cts');
}

// TS-only modifier keywords that must be removed from class members / params
// (NOT `static`/`accessor`, which are real JavaScript).
const TS_MODIFIER_RE = /\b(?:public|private|protected|readonly|abstract|override|declare)\b/g;

/* eslint-disable @typescript-eslint/no-explicit-any */
type Node = any;

class Blanker {
  private ranges: Array<[number, number]> = [];
  constructor(public readonly code: string) {}

  /** Mark a source range to be replaced with whitespace. */
  blank(start: number, end: number): void {
    if (end > start) this.ranges.push([start, end]);
  }

  /** Blank only TS modifier keywords within [start, end), keeping JS keywords. */
  blankModifiers(start: number, end: number): void {
    const slice = this.code.slice(start, end);
    let m: RegExpExecArray | null;
    TS_MODIFIER_RE.lastIndex = 0;
    while ((m = TS_MODIFIER_RE.exec(slice)) !== null) {
      this.blank(start + m.index, start + m.index + m[0].length);
    }
  }

  apply(): string {
    if (this.ranges.length === 0) return this.code;
    // Replace each range with whitespace, preserving newlines for line parity.
    const chars = this.code.split('');
    for (const [start, end] of this.ranges) {
      for (let i = start; i < end; i++) {
        if (chars[i] !== '\n' && chars[i] !== '\r') chars[i] = ' ';
      }
    }
    return chars.join('');
  }
}

/** Recursively walk the AST, recording TS-only ranges to blank. */
function visit(node: Node, b: Blanker): void {
  if (!node || typeof node !== 'object') return;
  const type: string = node.type;

  switch (type) {
    // Whole type-only declarations.
    case 'TSInterfaceDeclaration':
    case 'TSTypeAliasDeclaration':
    case 'TSDeclareFunction':
      b.blank(node.start, node.end);
      return;

    // `import type ...` / `export type ...` — drop entirely.
    case 'ImportDeclaration':
      if (node.importKind === 'type') {
        b.blank(node.start, node.end);
        return;
      }
      // Drop individual `type` specifiers (e.g. `import { a, type B } from ...`).
      for (const spec of node.specifiers ?? []) {
        if (spec.importKind === 'type') blankSpecifierWithComma(node.specifiers, spec, b);
      }
      break;
    case 'ExportNamedDeclaration':
    case 'ExportAllDeclaration':
      if (node.exportKind === 'type') {
        b.blank(node.start, node.end);
        return;
      }
      break;

    // Expression-level type syntax.
    case 'TSAsExpression':
    case 'TSSatisfiesExpression':
      // Keep the expression, drop ` as T` / ` satisfies T`.
      visit(node.expression, b);
      b.blank(node.expression.end, node.end);
      return;
    case 'TSNonNullExpression':
      // `expr!` -> `expr`
      visit(node.expression, b);
      b.blank(node.expression.end, node.end);
      return;
    case 'TSTypeAssertion':
      // `<T>expr` -> `expr`
      b.blank(node.start, node.expression.start);
      visit(node.expression, b);
      return;
    case 'TSInstantiationExpression':
      // `foo<number>` -> `foo`
      visit(node.expression, b);
      if (node.typeArguments) b.blank(node.typeArguments.start, node.typeArguments.end);
      else if (node.typeParameters) b.blank(node.typeParameters.start, node.typeParameters.end);
      return;
  }

  // `declare` statements (declare const/function/class/...).
  if (node.declare) {
    b.blank(node.start, node.end);
    return;
  }

  // Type annotations and signatures attached anywhere (`: T`, `=> : T`).
  if (node.typeAnnotation && node.typeAnnotation.type === 'TSTypeAnnotation') {
    // Handle optional `?` / definite `!` that sits just before the colon.
    blankOptionalOrDefinite(node, node.typeAnnotation.start, b);
    b.blank(node.typeAnnotation.start, node.typeAnnotation.end);
  } else if (node.optional || node.definite) {
    blankOptionalOrDefinite(node, undefined, b);
  }
  if (node.returnType && node.returnType.type === 'TSTypeAnnotation') {
    b.blank(node.returnType.start, node.returnType.end);
  }

  // Generic type parameters (`<T>` on declarations) and type arguments
  // (`foo<number>()`, `new C<number>()`) — both live under various keys.
  for (const key of ['typeParameters', 'typeArguments', 'superTypeArguments']) {
    const ta = node[key];
    if (ta && (ta.type === 'TSTypeParameterInstantiation' || ta.type === 'TSTypeParameterDeclaration')) {
      b.blank(ta.start, ta.end);
    }
  }

  // Class heritage: `implements X, Y`.
  if (Array.isArray(node.implements) && node.implements.length > 0) {
    const first = node.implements[0];
    const last = node.implements[node.implements.length - 1];
    // Blank back to the `implements` keyword.
    const kw = b.code.lastIndexOf('implements', first.start);
    if (kw !== -1) b.blank(kw, last.end);
  }

  // Class member / parameter modifiers (public/private/readonly/abstract/...).
  if ((type === 'PropertyDefinition' || type === 'MethodDefinition') && node.key) {
    if (node.accessibility || node.readonly || node.abstract || node.override) {
      b.blankModifiers(node.start, node.key.start);
    }
  }
  if (type === 'TSParameterProperty') {
    b.blankModifiers(node.start, node.parameter ? node.parameter.start : node.end);
    visit(node.parameter, b);
    return;
  }
  // `abstract class` keyword.
  if (type === 'ClassDeclaration' && node.abstract && typeof node.start === 'number') {
    const kw = b.code.indexOf('abstract', node.start);
    if (kw !== -1 && kw < (node.id ? node.id.start : node.end)) b.blank(kw, kw + 'abstract'.length);
  }

  // Recurse into children (skip the typeAnnotation/returnType we already blanked,
  // and skip pure-type subtrees which we don't need to descend).
  for (const k in node) {
    if (k === 'typeAnnotation' || k === 'returnType' || k === 'typeParameters' ||
        k === 'typeArguments' || k === 'superTypeArguments' || k === 'implements' ||
        k === 'loc' || k === 'range' || k === 'start' || k === 'end' || k === 'type') {
      continue;
    }
    const child = node[k];
    if (Array.isArray(child)) {
      for (const c of child) if (c && typeof c === 'object' && c.type) visit(c, b);
    } else if (child && typeof child === 'object' && child.type) {
      visit(child, b);
    }
  }
}

/**
 * Blank an optional `?` or definite-assignment `!` marker. acorn-typescript
 * gives unreliable end positions for some optional nodes, so we locate the
 * marker by scanning the source just before the type colon (or, when there is
 * no annotation, after the node's key).
 */
function blankOptionalOrDefinite(node: Node, annotationStart: number | undefined, b: Blanker): void {
  if (!node.optional && !node.definite) return;
  const code: string = b.code;

  // When there's a type annotation, the `?`/`!` is the last non-space char
  // before the colon. (acorn-typescript's optional-node end offsets are
  // unreliable, so scan from the colon backward instead.)
  if (annotationStart !== undefined) {
    let i = annotationStart - 1;
    while (i >= 0 && (code[i] === ' ' || code[i] === '\t')) i--;
    if (i >= 0 && (code[i] === '?' || code[i] === '!')) b.blank(i, i + 1);
    return;
  }

  // No annotation (e.g. `function f(a?) {}`): the marker follows the name.
  if (typeof node.start !== 'number') return;
  let i = node.start;
  while (i < code.length && /[A-Za-z0-9_$]/.test(code[i])) i++;
  while (i < code.length && (code[i] === ' ' || code[i] === '\t')) i++;
  if (code[i] === '?' || code[i] === '!') b.blank(i, i + 1);
}

/** Blank a type-only import/export specifier together with a separating comma. */
function blankSpecifierWithComma(specifiers: Node[], spec: Node, b: Blanker): void {
  const code: string = b.code;
  const idx = specifiers.indexOf(spec);
  // Prefer consuming a following comma; otherwise a preceding one.
  let end = spec.end;
  let start = spec.start;
  const after = code.slice(spec.end);
  const commaAfter = after.match(/^\s*,/);
  if (idx < specifiers.length - 1 && commaAfter) {
    end = spec.end + commaAfter[0].length;
  } else {
    // Last specifier: pull in the preceding comma.
    const before = code.slice(0, spec.start);
    const commaBefore = before.match(/,\s*$/);
    if (commaBefore) start = spec.start - commaBefore[0].length;
  }
  b.blank(start, end);
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Strip TypeScript types from source code, returning plain JavaScript.
 * Whitespace-preserving, so line/column positions are unchanged.
 */
export function stripTypeScriptTypes(code: string, _filename?: string): string {
  let ast: Node;
  try {
    // acorn-typescript requires `locations`. We still use character offsets
    // (.start/.end) for blanking.
    ast = TsParser.parse(code, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
  } catch {
    // If it doesn't parse as TS, return as-is and let the JS path report errors.
    return code;
  }
  const b = new Blanker(code);
  for (const stmt of ast.body) visit(stmt, b);
  return b.apply();
}
