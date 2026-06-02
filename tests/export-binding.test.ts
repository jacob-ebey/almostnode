import { describe, it, expect, beforeEach } from 'vitest';
import { VirtualFS } from '../src/virtual-fs';
import { Runtime } from '../src/runtime';

describe('named exports preserve their local binding', () => {
  let vfs: VirtualFS;
  let runtime: Runtime;

  beforeEach(() => {
    vfs = new VirtualFS();
    runtime = new Runtime(vfs);
  });

  it('lets later code mutate an exported const object', () => {
    vfs.writeFileSync(
      '/mod.js',
      `export const something = {};
       something.key = "value";`
    );
    vfs.writeFileSync(
      '/main.js',
      `const m = require('./mod');
       module.exports = m.something;`
    );
    const { exports } = runtime.runFile('/main.js') as { exports: any };
    expect(exports).toEqual({ key: 'value' });
  });

  it('lets module-scope code call an exported function', () => {
    vfs.writeFileSync(
      '/mod.js',
      `export function add(a, b) { return a + b; }
       export const sum = add(2, 3);`
    );
    vfs.writeFileSync('/main.js', `module.exports = require('./mod').sum;`);
    const { exports } = runtime.runFile('/main.js') as { exports: any };
    expect(exports).toBe(5);
  });

  it('lets module-scope code reference an exported class', () => {
    vfs.writeFileSync(
      '/mod.js',
      `export class Box { constructor(v) { this.v = v; } }
       export const boxed = new Box(7);`
    );
    vfs.writeFileSync('/main.js', `module.exports = require('./mod').boxed.v;`);
    const { exports } = runtime.runFile('/main.js') as { exports: any };
    expect(exports).toBe(7);
  });

  it('handles destructuring named exports', () => {
    vfs.writeFileSync(
      '/mod.js',
      `const src = { a: 1, b: 2, rest1: 3, rest2: 4 };
       export const { a, b, ...others } = src;
       export const [first] = [10, 20];`
    );
    vfs.writeFileSync(
      '/main.js',
      `const m = require('./mod');
       module.exports = { a: m.a, b: m.b, others: m.others, first: m.first };`
    );
    const { exports } = runtime.runFile('/main.js') as { exports: any };
    expect(exports).toEqual({ a: 1, b: 2, others: { rest1: 3, rest2: 4 }, first: 10 });
  });

  it('works for .ts files too', () => {
    vfs.writeFileSync(
      '/mod.ts',
      `export const config: Record<string, unknown> = {};
       config.ready = true;`
    );
    vfs.writeFileSync('/main.ts', `module.exports = require('./mod').config;`);
    const { exports } = runtime.runFile('/main.ts') as { exports: any };
    expect(exports).toEqual({ ready: true });
  });
});
