/**
 * JSX → JavaScript transform (pure JS, synchronous).
 *
 * Parses with `acorn` + `acorn-jsx` and replaces every JSX element/fragment
 * with calls to the configured factory. Supports both the classic runtime
 * (`React.createElement` / `React.Fragment`) and the automatic runtime
 * (`react/jsx-runtime`'s `jsx`/`jsxs`/`Fragment`, or the `*-dev` variants).
 *
 * Synchronous and dependency-light (acorn-jsx is already used elsewhere), so it
 * can run inside `require()` like the TypeScript type-stripping pass. For
 * `.tsx`, types are stripped first (whitespace-preserving) and this pass runs
 * over the resulting JS+JSX.
 */

import * as acorn from 'acorn';
import jsx from 'acorn-jsx';
import type { JsxConfig } from './jsx-config';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const JsxParser = (acorn.Parser as any).extend(jsx());

/* eslint-disable @typescript-eslint/no-explicit-any */
type Node = any;

/** Module resolution extensions to try for JSX files. */
export const JSX_RESOLVE_EXTENSIONS = ['.tsx', '.jsx'] as const;

/** Returns true for `.jsx`/`.tsx` files. */
export function isJsxFile(filename: string): boolean {
  return /\.(jsx|tsx)$/.test(filename);
}

/** `.tsx` files need TypeScript type-stripping before the JSX transform. */
export function isTsxFile(filename: string): boolean {
  return filename.endsWith('.tsx');
}

/**
 * Decode the handful of HTML entities JSX text commonly contains. Babel/React
 * decode entities in JSX text and string-literal attribute values.
 */
function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      return Number.isNaN(code) ? whole : String.fromCodePoint(code);
    }
    const named: Record<string, string> = {
      amp: '&',
      lt: '<',
      gt: '>',
      quot: '"',
      apos: "'",
      nbsp: '\u00a0',
      copy: '\u00a9',
      reg: '\u00ae',
    };
    return named[body] ?? whole;
  });
}

/**
 * Collapse JSX text per the JSX whitespace rules (matches Babel):
 * lines are trimmed at element boundaries and joined with single spaces; lines
 * that are entirely whitespace are dropped. Returns `null` if nothing remains.
 */
function cleanJsxText(raw: string): string | null {
  const lines = raw.split(/\r\n|\n|\r/);
  let lastNonEmpty = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/[^ \t]/.test(lines[i])) lastNonEmpty = i;
  }

  let str = '';
  for (let i = 0; i < lines.length; i++) {
    const isFirst = i === 0;
    const isLast = i === lines.length - 1;
    const isLastNonEmpty = i === lastNonEmpty;
    let trimmed = lines[i].replace(/\t/g, ' ');
    if (!isFirst) trimmed = trimmed.replace(/^ +/, '');
    if (!isLast) trimmed = trimmed.replace(/ +$/, '');
    if (trimmed) {
      if (!isLastNonEmpty) trimmed += ' ';
      str += trimmed;
    }
  }
  return str === '' ? null : decodeEntities(str);
}

class JsxCodegen {
  /** Names bound by the injected automatic-runtime import. */
  needsAutomaticImport = false;

  constructor(
    private readonly code: string,
    private readonly cfg: JsxConfig,
    private readonly allJsx: Node[],
  ) {}

  /** Transform a source range, replacing the outermost JSX nodes within it. */
  transformRange(start: number, end: number): string {
    const inRange = this.allJsx.filter((n) => n.start >= start && n.end <= end);
    const outer = inRange.filter(
      (n) => !inRange.some((o) => o !== n && o.start <= n.start && o.end >= n.end),
    );
    outer.sort((a, b) => a.start - b.start);

    let out = '';
    let cursor = start;
    for (const node of outer) {
      out += this.code.slice(cursor, node.start);
      out += this.genElement(node);
      cursor = node.end;
    }
    out += this.code.slice(cursor, end);
    return out;
  }

  /** JS expression string for a JSXElement / JSXFragment. */
  private genElement(node: Node): string {
    const isFragment = node.type === 'JSXFragment';
    const tag = isFragment ? null : this.genTag(node.openingElement.name);
    const attributes: Node[] = isFragment ? [] : node.openingElement.attributes;
    const children = this.genChildren(node.children);

    if (this.cfg.mode === 'classic') {
      const tagExpr = isFragment ? this.cfg.fragmentFactory : tag;
      const props = this.genClassicProps(attributes);
      const args = [tagExpr, props, ...children];
      // Drop the trailing `null` props arg entirely when there are no children.
      if (children.length === 0 && props === 'null') args.length = 1;
      return `${this.cfg.factory}(${args.join(', ')})`;
    }

    // Automatic runtime.
    this.needsAutomaticImport = true;
    const dev = this.cfg.mode === 'automatic-dev';
    const { key, props } = this.genAutomaticProps(attributes, children);
    const tagExpr = isFragment ? '_Fragment' : (tag as string);
    const isStatic = children.length > 1;
    const callee = dev ? '_jsxDEV' : isStatic ? '_jsxs' : '_jsx';

    if (dev) {
      const args = [tagExpr, props, key ?? 'void 0', String(isStatic), 'void 0', 'void 0'];
      return `${callee}(${args.join(', ')})`;
    }
    const args = [tagExpr, props];
    if (key) args.push(key);
    return `${callee}(${args.join(', ')})`;
  }

  /** Element name → tag expression (string literal for intrinsics, else ident). */
  private genTag(name: Node): string {
    if (name.type === 'JSXIdentifier') {
      // Lowercase or hyphenated names are intrinsic (HTML) → string literal.
      if (/^[a-z]/.test(name.name) || name.name.includes('-')) {
        return JSON.stringify(name.name);
      }
      return name.name;
    }
    if (name.type === 'JSXMemberExpression') {
      return `${this.genTag(name.object)}.${name.property.name}`;
    }
    if (name.type === 'JSXNamespacedName') {
      return JSON.stringify(`${name.namespace.name}:${name.name.name}`);
    }
    return 'undefined';
  }

  private attrName(name: Node): string {
    const raw =
      name.type === 'JSXNamespacedName'
        ? `${name.namespace.name}:${name.name.name}`
        : name.name;
    // Quote keys that aren't valid bare identifiers.
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(raw) ? raw : JSON.stringify(raw);
  }

  private attrValue(value: Node): string {
    if (value == null) return 'true'; // boolean shorthand: <input disabled />
    if (value.type === 'Literal') return JSON.stringify(decodeEntities(String(value.value)));
    if (value.type === 'JSXExpressionContainer') {
      return this.transformRange(value.expression.start, value.expression.end);
    }
    if (value.type === 'JSXElement' || value.type === 'JSXFragment') {
      return this.genElement(value);
    }
    return this.code.slice(value.start, value.end);
  }

  /** Classic props: object literal or `null`. */
  private genClassicProps(attributes: Node[]): string {
    if (attributes.length === 0) return 'null';
    const parts: string[] = [];
    for (const attr of attributes) {
      if (attr.type === 'JSXSpreadAttribute') {
        parts.push(`...${this.transformRange(attr.argument.start, attr.argument.end)}`);
      } else {
        parts.push(`${this.attrName(attr.name)}: ${this.attrValue(attr.value)}`);
      }
    }
    return parts.length === 0 ? '{}' : `{ ${parts.join(', ')} }`;
  }

  /**
   * Automatic props: object literal that also carries `children`, with `key`
   * pulled out into a separate return value (passed as a positional argument).
   */
  private genAutomaticProps(
    attributes: Node[],
    children: string[],
  ): { key: string | null; props: string } {
    const parts: string[] = [];
    let key: string | null = null;
    for (const attr of attributes) {
      if (attr.type === 'JSXSpreadAttribute') {
        parts.push(`...${this.transformRange(attr.argument.start, attr.argument.end)}`);
        continue;
      }
      const name = this.attrName(attr.name);
      if (name === 'key') {
        key = this.attrValue(attr.value);
        continue;
      }
      parts.push(`${name}: ${this.attrValue(attr.value)}`);
    }
    if (children.length === 1) {
      parts.push(`children: ${children[0]}`);
    } else if (children.length > 1) {
      parts.push(`children: [${children.join(', ')}]`);
    }
    return { key, props: parts.length === 0 ? '{}' : `{ ${parts.join(', ')} }` };
  }

  /** Generate the list of child expression strings (whitespace-only dropped). */
  private genChildren(children: Node[]): string[] {
    const out: string[] = [];
    for (const child of children) {
      if (child.type === 'JSXText') {
        const text = cleanJsxText(child.value);
        if (text !== null) out.push(JSON.stringify(text));
      } else if (child.type === 'JSXExpressionContainer') {
        if (child.expression.type === 'JSXEmptyExpression') continue; // `{/* comment */}`
        out.push(this.transformRange(child.expression.start, child.expression.end));
      } else if (child.type === 'JSXSpreadChild') {
        out.push(`...${this.transformRange(child.expression.start, child.expression.end)}`);
      } else if (child.type === 'JSXElement' || child.type === 'JSXFragment') {
        out.push(this.genElement(child));
      }
    }
    return out;
  }
}

/** Collect every JSXElement / JSXFragment node in the tree. */
function collectJsx(ast: Node): Node[] {
  const found: Node[] = [];
  const visit = (node: Node): void => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'JSXElement' || node.type === 'JSXFragment') found.push(node);
    for (const k in node) {
      if (k === 'loc' || k === 'range' || k === 'start' || k === 'end' || k === 'type') continue;
      const child = node[k];
      if (Array.isArray(child)) {
        for (const c of child) if (c && typeof c === 'object') visit(c);
      } else if (child && typeof child === 'object') {
        visit(child);
      }
    }
  };
  visit(ast);
  return found;
}

/**
 * Transform JSX in `code` to plain JavaScript using the given config. Returns
 * the input unchanged if there is no JSX (or it fails to parse).
 */
export function transformJsx(code: string, cfg: JsxConfig): string {
  // Fast bail: no `<` at all means no JSX.
  if (!code.includes('<')) return code;

  let ast: Node;
  try {
    ast = JsxParser.parse(code, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
  } catch {
    return code;
  }

  const allJsx = collectJsx(ast);
  if (allJsx.length === 0) return code;

  const gen = new JsxCodegen(code, cfg, allJsx);
  let out = gen.transformRange(0, code.length);

  if (gen.needsAutomaticImport) {
    const dev = cfg.mode === 'automatic-dev';
    const runtime = `${cfg.importSource}/${dev ? 'jsx-dev-runtime' : 'jsx-runtime'}`;
    const names = dev
      ? 'jsxDEV as _jsxDEV, Fragment as _Fragment'
      : 'jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment';
    out = `import { ${names} } from ${JSON.stringify(runtime)};\n${out}`;
  }

  return out;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
