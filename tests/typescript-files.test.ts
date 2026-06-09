import { describe, it, expect, beforeEach } from 'vitest';
import { VirtualFS } from '../src/virtual-fs';
import { Runtime } from '../src/runtime';

describe('TypeScript (.ts/.mts/.cts) support', () => {
  let vfs: VirtualFS;
  let runtime: Runtime;

  beforeEach(() => {
    vfs = new VirtualFS();
    runtime = new Runtime(vfs);
  });

  it('strips type annotations and runs a .ts file', () => {
    vfs.writeFileSync(
      '/app.ts',
      `const x: number = 21;
       function double(n: number): number { return n * 2; }
       module.exports = double(x);`
    );
    const { exports } = runtime.runFile('/app.ts');
    expect(exports).toBe(42);
  });

  it('strips interfaces, type aliases and generics', () => {
    vfs.writeFileSync(
      '/g.ts',
      `interface Box<T> { value: T }
       type ID = string | number;
       function unwrap<T>(b: Box<T>): T { return b.value; }
       const id: ID = 7;
       module.exports = unwrap<number>({ value: id });`
    );
    const { exports } = runtime.runFile('/g.ts');
    expect(exports).toBe(7);
  });

  it('handles ESM import/export in .ts files', () => {
    vfs.writeFileSync(
      '/math.ts',
      `export const add = (a: number, b: number): number => a + b;
       export type Pair = [number, number];`
    );
    vfs.writeFileSync(
      '/main.ts',
      `import { add } from './math';
       import type { Pair } from './math';
       const p = [2, 3] as Pair;
       module.exports = add(p[0], p[1]);`
    );
    const { exports } = runtime.runFile('/main.ts');
    expect(exports).toBe(5);
  });

  it('resolves require() of a .ts file without extension', () => {
    vfs.writeFileSync('/lib/util.ts', `export const greet = (n: string): string => 'hi ' + n;`);
    vfs.writeFileSync(
      '/index.ts',
      `const { greet } = require('./lib/util');
       module.exports = greet('node');`
    );
    const { exports } = runtime.runFile('/index.ts');
    expect(exports).toBe('hi node');
  });

  it('resolves a directory index.ts', () => {
    vfs.writeFileSync('/pkg/index.ts', `exports.ok = true as boolean;`);
    vfs.writeFileSync('/main.ts', `module.exports = require('./pkg').ok;`);
    const { exports } = runtime.runFile('/main.ts');
    expect(exports).toBe(true);
  });

  it('treats .cts as CommonJS', () => {
    vfs.writeFileSync(
      '/cjs.cts',
      `const value: number = 99;
       module.exports = { value };`
    );
    const { exports } = runtime.runFile('/cjs.cts');
    expect(exports).toEqual({ value: 99 });
  });

  it('strips as/satisfies, non-null and definite assignment', () => {
    vfs.writeFileSync(
      '/assert.ts',
      `const raw: unknown = { n: 41 };
       const obj = raw as { n: number };
       const cfg = { x: 1 } satisfies Record<string, number>;
       let later!: number;
       later = obj.n + cfg.x;
       module.exports = later;`
    );
    const { exports } = runtime.runFile('/assert.ts');
    expect(exports).toBe(42);
  });

  it('strips class member modifiers and generics', () => {
    vfs.writeFileSync(
      '/cls.ts',
      `class Counter<T extends number> {
         private readonly base: T;
         count!: number;
         constructor(base: T) { this.base = base; this.count = base; }
         inc(by: number): number { this.count += by; return this.count; }
       }
       const c = new Counter<number>(40);
       module.exports = c.inc(2);`
    );
    const { exports } = runtime.runFile('/cls.ts');
    expect(exports).toBe(42);
  });

  it('emits enums as runtime objects', () => {
    vfs.writeFileSync(
      '/enum.ts',
      `enum Direction { Up, Down, Left, Right }
       const d: Direction = Direction.Down;
       module.exports = { value: d, name: Direction[d] };`
    );
    const { exports } = runtime.runFile('/enum.ts');
    expect(exports).toEqual({ value: 1, name: 'Down' });
  });

  it('emits constructor parameter properties', () => {
    vfs.writeFileSync(
      '/params.ts',
      `class Point {
         constructor(private x: number, readonly y: number) {}
         sum(): number { return this.x + this.y; }
       }
       module.exports = new Point(40, 2).sum();`
    );
    const { exports } = runtime.runFile('/params.ts');
    expect(exports).toBe(42);
  });

  it('treats .mts as ESM', () => {
    vfs.writeFileSync('/dep.mts', `export const n: number = 3;`);
    vfs.writeFileSync(
      '/m.mts',
      `import { n } from './dep';
       export const total: number = n + 1;`
    );
    const { exports } = runtime.runFile('/m.mts');
    expect((exports as { total: number }).total).toBe(4);
  });
});
