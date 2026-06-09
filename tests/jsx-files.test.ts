import { describe, it, expect, beforeEach } from 'vitest';
import { VirtualFS } from '../src/virtual-fs';
import { Runtime } from '../src/runtime';
import { transformJsx } from '../src/frameworks/jsx-transform';
import { resolveJsxConfig, DEFAULT_JSX_CONFIG } from '../src/frameworks/jsx-config';

const classic = {
  mode: 'classic' as const,
  importSource: 'react',
  factory: 'React.createElement',
  fragmentFactory: 'React.Fragment',
};

describe('JSX transform (codegen)', () => {
  it('automatic runtime: element with props, key, spread and children', () => {
    const out = transformJsx(
      'const el = <div className="a" key={id} {...rest}>hi {name}<span/></div>;',
      DEFAULT_JSX_CONFIG
    );
    expect(out).toContain('import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime"');
    // multiple children -> _jsxs, key pulled out to 3rd arg
    expect(out).toContain('_jsxs("div", {');
    expect(out).toContain('className: "a"');
    expect(out).toContain('...rest');
    expect(out).toContain('children: ["hi ", name, _jsx("span", {})]');
    expect(out).toMatch(/}, id\)/);
  });

  it('classic runtime: React.createElement with null props', () => {
    const out = transformJsx('const el = <span/>;', classic);
    expect(out).toContain('React.createElement("span")');
    expect(out).not.toContain('createElement("span", null)');
    expect(out).not.toContain('jsx-runtime');
  });

  it('classic runtime: fragment + member-expression component', () => {
    const out = transformJsx('const el = <><Foo.Bar a={1}>{k}</Foo.Bar></>;', classic);
    expect(out).toContain('React.createElement(React.Fragment, null,');
    expect(out).toContain('React.createElement(Foo.Bar, { a: 1 }, k)');
  });

  it('handles nested JSX inside expressions', () => {
    const out = transformJsx('const el = <ul>{items.map(i => <li>{i}</li>)}</ul>;', DEFAULT_JSX_CONFIG);
    expect(out).toContain('_jsx("ul", {');
    expect(out).toContain('items.map(i => _jsx("li", {');
  });

  it('dev runtime emits _jsxDEV', () => {
    const out = transformJsx('const el = <div/>;', {
      ...DEFAULT_JSX_CONFIG,
      mode: 'automatic-dev',
    });
    expect(out).toContain('jsx-dev-runtime');
    expect(out).toContain('_jsxDEV("div", {}, void 0, false');
  });

  it('respects custom jsxImportSource', () => {
    const out = transformJsx('const el = <div/>;', {
      ...DEFAULT_JSX_CONFIG,
      importSource: 'preact',
    });
    expect(out).toContain('from "preact/jsx-runtime"');
  });
});

describe('JSX config resolution (tsconfig/jsconfig walk)', () => {
  let vfs: VirtualFS;
  beforeEach(() => {
    vfs = new VirtualFS();
  });

  it('returns defaults when no config exists', () => {
    expect(resolveJsxConfig(vfs, '/src/app.tsx')).toEqual(DEFAULT_JSX_CONFIG);
  });

  it('reads jsx mode from nearest tsconfig.json (walking up)', () => {
    vfs.writeFileSync('/tsconfig.json', '{ "compilerOptions": { "jsx": "react" } }');
    const cfg = resolveJsxConfig(vfs, '/src/components/app.tsx');
    expect(cfg.mode).toBe('classic');
  });

  it('prefers a deeper config over a shallower one', () => {
    vfs.writeFileSync('/tsconfig.json', '{ "compilerOptions": { "jsx": "react" } }');
    vfs.writeFileSync('/src/tsconfig.json', '{ "compilerOptions": { "jsx": "react-jsx" } }');
    expect(resolveJsxConfig(vfs, '/src/app.tsx').mode).toBe('automatic');
  });

  it('falls back to jsconfig.json and tolerates comments/trailing commas', () => {
    vfs.writeFileSync(
      '/jsconfig.json',
      `{
        // jsx settings
        "compilerOptions": {
          "jsx": "react",
          "jsxFactory": "h",
          "jsxFragmentFactory": "Fragment", /* preact classic */
        },
      }`
    );
    const cfg = resolveJsxConfig(vfs, '/app.jsx');
    expect(cfg).toMatchObject({ mode: 'classic', factory: 'h', fragmentFactory: 'Fragment' });
  });

  it('reads jsxImportSource', () => {
    vfs.writeFileSync(
      '/tsconfig.json',
      '{ "compilerOptions": { "jsx": "react-jsx", "jsxImportSource": "preact" } }'
    );
    expect(resolveJsxConfig(vfs, '/app.tsx').importSource).toBe('preact');
  });
});

describe('Running .jsx/.tsx files through the runtime', () => {
  let vfs: VirtualFS;
  let runtime: Runtime;

  beforeEach(() => {
    vfs = new VirtualFS();
    runtime = new Runtime(vfs);
    // Minimal automatic + classic React runtimes that just record the calls.
    vfs.writeFileSync('/node_modules/react/package.json', JSON.stringify({ name: 'react', version: '0.0.0' }));
    vfs.writeFileSync(
      '/node_modules/react/jsx-runtime.js',
      `const h = (type, props) => ({ type, props });
       exports.Fragment = 'Fragment';
       exports.jsx = h;
       exports.jsxs = h;`
    );
    vfs.writeFileSync(
      '/node_modules/react/index.js',
      `exports.Fragment = 'Fragment';
       exports.createElement = (type, props, ...children) => ({ type, props, children });`
    );
  });

  it('runs a .tsx file with the automatic runtime (default)', () => {
    vfs.writeFileSync(
      '/app.tsx',
      `const name: string = 'world';
       const el = <div className="greeting">hello {name}</div>;
       module.exports = el;`
    );
    const { exports } = runtime.runFile('/app.tsx') as { exports: any };
    expect(exports.type).toBe('div');
    expect(exports.props.className).toBe('greeting');
    expect(exports.props.children).toEqual(['hello ', 'world']);
  });

  it('runs a .tsx file with a custom automatic runtime (Preact via jsxImportSource)', () => {
    vfs.writeFileSync(
      '/tsconfig.json',
      '{ "compilerOptions": { "jsx": "react-jsx", "jsxImportSource": "preact" } }'
    );
    vfs.writeFileSync(
      '/node_modules/preact/jsx-runtime.js',
      `const h = (type, props) => ({ runtime: 'preact', type, props });
       exports.Fragment = 'PreactFragment';
       exports.jsx = h;
       exports.jsxs = h;`
    );
    vfs.writeFileSync(
      '/app.tsx',
      `const label: string = 'hi';
       const el = <span title={label}>x</span>;
       module.exports = el;`
    );
    const { exports } = runtime.runFile('/app.tsx') as { exports: any };
    expect(exports.runtime).toBe('preact');
    expect(exports.type).toBe('span');
    expect(exports.props.title).toBe('hi');
  });

  it('runs a .tsx file with a custom classic factory (Preact h/Fragment)', () => {
    vfs.writeFileSync(
      '/tsconfig.json',
      '{ "compilerOptions": { "jsx": "react", "jsxFactory": "h", "jsxFragmentFactory": "Fragment" } }'
    );
    vfs.writeFileSync(
      '/app.tsx',
      `const h = (type, props, ...children) => ({ runtime: 'preact-classic', type, props, children });
       const Fragment = 'PF';
       const x: number = 2;
       module.exports = <div data-x={x}>a</div>;`
    );
    const { exports } = runtime.runFile('/app.tsx') as { exports: any };
    expect(exports.runtime).toBe('preact-classic');
    expect(exports.type).toBe('div');
    expect(exports.props['data-x']).toBe(2);
  });

  it('runs a .jsx file with the classic runtime when configured', () => {
    vfs.writeFileSync('/tsconfig.json', '{ "compilerOptions": { "jsx": "react" } }');
    vfs.writeFileSync(
      '/app.jsx',
      `const React = require('react');
       const el = <ul><li>a</li><li>b</li></ul>;
       module.exports = el;`
    );
    const { exports } = runtime.runFile('/app.jsx') as { exports: any };
    expect(exports.type).toBe('ul');
    expect(exports.children).toHaveLength(2);
    expect(exports.children[0].type).toBe('li');
  });

  it('lets a .ts file import a .ts module by its .js extension', () => {
    vfs.writeFileSync('/util.ts', `export const n: number = 41;`);
    vfs.writeFileSync(
      '/main.ts',
      `import { n } from './util.js';
       module.exports = n + 1;`
    );
    const { exports } = runtime.runFile('/main.ts') as { exports: any };
    expect(exports).toBe(42);
  });

  it('lets a .ts file import a .tsx module by its .jsx extension', () => {
    vfs.writeFileSync('/Card.tsx', `export const Card = () => <div>hi</div>;`);
    vfs.writeFileSync(
      '/main.ts',
      `import { Card } from './Card.jsx';
       module.exports = Card();`
    );
    const { exports } = runtime.runFile('/main.ts') as { exports: any };
    expect(exports.type).toBe('div');
  });

  it('lets a plain .js file require a .ts module via its .js extension', () => {
    vfs.writeFileSync('/lib.ts', `export const greet = (s: string): string => 'hi ' + s;`);
    vfs.writeFileSync(
      '/main.js',
      `const { greet } = require('./lib.js');
       module.exports = greet('ts');`
    );
    const { exports } = runtime.runFile('/main.js') as { exports: any };
    expect(exports).toBe('hi ts');
  });

  it('prefers a real .js sibling over the rewritten .ts', () => {
    vfs.writeFileSync('/dep.js', `module.exports = 'from-js';`);
    vfs.writeFileSync('/dep.ts', `module.exports = 'from-ts';`);
    vfs.writeFileSync('/main.ts', `module.exports = require('./dep.js');`);
    const { exports } = runtime.runFile('/main.ts') as { exports: any };
    expect(exports).toBe('from-js');
  });

  it('resolves require() of a .tsx file without extension', () => {
    vfs.writeFileSync(
      '/components/Card.tsx',
      `export const Card = ({ title }: { title: string }) => <div>{title}</div>;`
    );
    vfs.writeFileSync(
      '/main.tsx',
      `const { Card } = require('./components/Card');
       module.exports = Card({ title: 'hi' });`
    );
    const { exports } = runtime.runFile('/main.tsx') as { exports: any };
    expect(exports.type).toBe('div');
    expect(exports.props.children).toBe('hi');
  });
});
