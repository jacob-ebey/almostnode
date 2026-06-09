/**
 * TypeScript → JavaScript transform
 *
 * Uses `sucrase` — a small (~1MB vs the ~24MB `typescript` compiler),
 * pure-JS, synchronous transpiler (no type-checking, no wasm, no Node
 * built-ins). Synchronicity is required because it runs inside `require()`.
 *
 * We keep this step "TS → JS only" so our own passes still run afterwards:
 *   - The `imports` transform is NOT enabled, so ES `import`/`export` survive
 *     for our ESM→CJS transform (`transformEsmToCjs`).
 *   - For `.ts/.mts/.cts` (which can never contain JSX) we enable only the
 *     `typescript` transform.
 *
 * `.tsx` is special: sucrase's parser only accepts JSX when the `jsx` transform
 * is enabled, so it cannot strip types while leaving JSX intact. For `.tsx` we
 * therefore let sucrase compile the JSX too, mapping our resolved `JsxConfig`
 * onto sucrase's JSX options. (`.jsx`, which has no types, keeps using our own
 * `transformJsx` pass.)
 *
 * Because sucrase is a real transpiler (not a whitespace type-stripper),
 * constructs that need code generation — `enum`, constructor parameter
 * properties — are emitted correctly. Like Node's `--experimental-strip-types`,
 * `namespace`s with runtime members are not emitted (they require a real build
 * step).
 */

import { transform, type Options as SucraseOptions, type Transform } from 'sucrase';
import type { JsxConfig } from './jsx-config';

// Node's native type-stripping supports .ts/.mts/.cts only — not .tsx (JSX).
const TS_EXTENSIONS = ['.ts', '.mts', '.cts'] as const;

/** Module resolution extensions to try for TypeScript files. */
export const TS_RESOLVE_EXTENSIONS = [...TS_EXTENSIONS];

/** Returns true if the filename is a TypeScript source file (not .tsx). */
export function isTypeScriptFile(filename: string): boolean {
  return /\.(ts|mts|cts)$/.test(filename);
}

/**
 * `.cts` is CommonJS TypeScript — like `.cjs`, it should not run the
 * ESM→CJS transform after this step.
 */
export function isCommonJsTypeScriptFile(filename: string): boolean {
  return filename.endsWith('.cts');
}

/** Map our resolved JSX config onto sucrase's JSX transform options. */
function jsxSucraseOptions(cfg: JsxConfig): Partial<SucraseOptions> {
  if (cfg.mode === 'classic') {
    return {
      jsxRuntime: 'classic',
      jsxPragma: cfg.factory,
      jsxFragmentPragma: cfg.fragmentFactory,
    };
  }
  // 'automatic' | 'automatic-dev'
  return {
    jsxRuntime: 'automatic',
    jsxImportSource: cfg.importSource,
    production: cfg.mode === 'automatic',
  };
}

/**
 * Transform TypeScript source to JavaScript, preserving ESM so the downstream
 * ESM→CJS pass can run.
 *
 * For `.tsx`, pass the resolved `JsxConfig` so sucrase also compiles the JSX
 * (the caller should then skip the separate `transformJsx` pass). For
 * `.ts/.mts/.cts`, omit `jsxConfig`.
 *
 * The name is kept for backwards compatibility with call sites; it now performs
 * a full TS→JS emit rather than whitespace-only type stripping.
 */
export function stripTypeScriptTypes(
  code: string,
  filename?: string,
  jsxConfig?: JsxConfig
): string {
  const isTsx = filename ? filename.endsWith('.tsx') : false;
  const transforms: Transform[] = isTsx ? ['typescript', 'jsx'] : ['typescript'];

  const options: SucraseOptions = {
    transforms,
    // Keep modern output (don't down-level optional chaining, nullish, etc.).
    disableESTransforms: true,
    // Leave `import(...)` untouched for our dynamic-import handling.
    preserveDynamicImport: true,
    filePath: filename,
    ...(isTsx ? jsxSucraseOptions(jsxConfig ?? defaultJsxConfig) : {}),
  };

  return transform(code, options).code;
}

// Fallback JSX config for `.tsx` when none was resolved (modern default:
// automatic runtime from "react").
const defaultJsxConfig: JsxConfig = {
  mode: 'automatic',
  importSource: 'react',
  factory: 'React.createElement',
  fragmentFactory: 'React.Fragment',
};
