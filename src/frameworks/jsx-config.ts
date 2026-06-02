/**
 * JSX transform configuration resolution.
 *
 * Determines how `.jsx`/`.tsx` files should be compiled by reading the nearest
 * `tsconfig.json` (or `jsconfig.json`) in the VFS, walking upward from the
 * directory of the script being transformed until one is found.
 *
 * The relevant `compilerOptions` are:
 *   - `jsx`                 "react" | "react-jsx" | "react-jsxdev" |
 *                           "preserve" | "react-native"
 *   - `jsxImportSource`     module to import the automatic runtime from
 *                           (default "react")
 *   - `jsxFactory`          classic element factory (default "React.createElement")
 *   - `jsxFragmentFactory`  classic fragment factory (default "React.Fragment")
 */

/** Minimal filesystem surface needed to resolve config (matches VirtualFS). */
export interface ConfigFs {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: 'utf8'): string;
}

export type JsxMode = 'classic' | 'automatic' | 'automatic-dev';

export interface JsxConfig {
  mode: JsxMode;
  /** Automatic runtime import source (e.g. "react"). */
  importSource: string;
  /** Classic element factory (e.g. "React.createElement"). */
  factory: string;
  /** Classic fragment factory (e.g. "React.Fragment"). */
  fragmentFactory: string;
}

/** Defaults mirror a modern setup: automatic runtime, React. */
export const DEFAULT_JSX_CONFIG: JsxConfig = {
  mode: 'automatic',
  importSource: 'react',
  factory: 'React.createElement',
  fragmentFactory: 'React.Fragment',
};

/**
 * Strip `//` and block comments and trailing commas from JSONC text so that
 * it can be parsed with `JSON.parse`. tsconfig/jsconfig files commonly contain
 * comments.
 */
function parseJsonc(text: string): unknown {
  let out = '';
  let inString = false;
  let stringQuote = '';
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false;
        out += ch;
      }
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === '\\') {
        // Preserve escaped char verbatim.
        out += text[i + 1] ?? '';
        i++;
      } else if (ch === stringQuote) {
        inString = false;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      stringQuote = ch;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i++;
      continue;
    }
    out += ch;
  }

  // Remove trailing commas: `,}` / `,]` (whitespace allowed between).
  out = out.replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(out);
}

function dirname(p: string): string {
  const idx = p.lastIndexOf('/');
  if (idx <= 0) return '/';
  return p.slice(0, idx);
}

/** Map a tsconfig `jsx` option to our internal transform mode. */
function modeFromJsxOption(jsx: unknown): JsxMode {
  switch (jsx) {
    case 'react':
      return 'classic';
    case 'react-jsxdev':
      return 'automatic-dev';
    case 'react-jsx':
    case 'preserve':
    case 'react-native':
    default:
      // "preserve"/"react-native" can't actually run as-is; fall back to the
      // modern automatic runtime so the file still executes.
      return 'automatic';
  }
}

/**
 * Resolve the JSX transform config for `filePath` by walking up the directory
 * tree looking for a `tsconfig.json` or `jsconfig.json` in the VFS. Returns the
 * default config if none is found.
 */
export function resolveJsxConfig(fs: ConfigFs, filePath: string): JsxConfig {
  let dir = dirname(filePath);

  // Walk upward toward the root.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    for (const name of ['tsconfig.json', 'jsconfig.json']) {
      const candidate = `${dir === '/' ? '' : dir}/${name}`;
      if (!fs.existsSync(candidate)) continue;
      try {
        const parsed = parseJsonc(fs.readFileSync(candidate, 'utf8')) as {
          compilerOptions?: Record<string, unknown>;
        };
        const co = parsed.compilerOptions ?? {};
        return {
          mode: 'jsx' in co ? modeFromJsxOption(co.jsx) : DEFAULT_JSX_CONFIG.mode,
          importSource:
            typeof co.jsxImportSource === 'string'
              ? co.jsxImportSource
              : DEFAULT_JSX_CONFIG.importSource,
          factory:
            typeof co.jsxFactory === 'string' ? co.jsxFactory : DEFAULT_JSX_CONFIG.factory,
          fragmentFactory:
            typeof co.jsxFragmentFactory === 'string'
              ? co.jsxFragmentFactory
              : DEFAULT_JSX_CONFIG.fragmentFactory,
        };
      } catch {
        // Malformed config — keep walking; fall back to defaults if none parse.
      }
    }

    if (dir === '/' || dir === '') break;
    dir = dirname(dir);
  }

  return DEFAULT_JSX_CONFIG;
}
