/**
 * Integration tests: transform-worker output must compile with Hermes.
 *
 * For each input source, we run it through the SWC-based Metro transform
 * worker and then feed the resulting module code to `hermesc -emit-binary`.
 * If hermesc exits non-zero, the transformer produced syntax that Hermes
 * cannot parse — which would break React Native at runtime.
 *
 * This catches regressions where e.g. SWC emits ESNext syntax that hermesc
 * rejects (top-level await, class static blocks without downleveling, etc.).
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { transform } from '../src/transform-worker';
import type { JsTransformerConfig, JsTransformOptions } from '../src/types';

const baseConfig: JsTransformerConfig = {
  allowOptionalDependencies: false,
  assetPlugins: [],
  assetRegistryPath: '',
  asyncRequireModulePath: 'asyncRequire',
  babelTransformerPath: '',
  dynamicDepsInPackages: 'reject',
  enableBabelRCLookup: false,
  enableBabelRuntime: true,
  globalPrefix: '',
  hermesParser: false,
  minifierConfig: { output: { comments: false } },
  minifierPath: 'minifyModulePath',
  optimizationSizeLimit: 100000,
  publicPath: '/assets',
  unstable_dependencyMapReservedName: null,
  unstable_disableModuleWrapping: false,
  unstable_disableNormalizePseudoGlobals: false,
  unstable_allowRequireContext: false,
};

const baseTransformOptions: JsTransformOptions = {
  dev: true,
  inlinePlatform: false,
  inlineRequires: false,
  minify: false,
  platform: 'ios',
  type: 'module',
  unstable_transformProfile: 'default',
};

function resolveHermesc() {
  const platformDir =
    process.platform === 'darwin'
      ? 'osx-bin'
      : process.platform === 'linux'
        ? 'linux64-bin'
        : process.platform === 'win32'
          ? 'win64-bin'
          : null;
  if (platformDir === null) {
    throw new Error(
      `hermes-integration tests require a hermesc binary; platform ${process.platform} is not supported by hermes-compiler.`,
    );
  }
  const pkg = require.resolve('hermes-compiler/package.json');
  const bin = path.join(
    path.dirname(pkg),
    'hermesc',
    platformDir,
    process.platform === 'win32' ? 'hermesc.exe' : 'hermesc',
  );
  require('fs').accessSync(bin, require('fs').constants.X_OK);
  return bin;
}

const HERMESC = resolveHermesc();

let tmpDir: string;
beforeAll(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'rn-swc-hermes-'));
});
afterAll(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

function compileWithHermes(code: string, name: string): void {
  const src = path.join(tmpDir, `${name}.js`);
  const out = path.join(tmpDir, `${name}.hbc`);
  writeFileSync(src, code);
  try {
    execFileSync(HERMESC, ['-emit-binary', `-out=${out}`, src], {
      stdio: 'pipe',
    });
  } catch (err) {
    const e = err as { stderr?: Buffer | string; stdout?: Buffer | string };
    const stderr = e.stderr?.toString() ?? '';
    const stdout = e.stdout?.toString() ?? '';
    throw new Error(
      `hermesc rejected transformed code:\n${stderr}${stdout}\n\n--- transformed source ---\n${code}`,
    );
  }
}

interface TransformAndCompileOptions {
  filename?: string;
  testName?: string;
  options?: Partial<JsTransformOptions>;
}

async function transformAndCompile(
  source: string,
  { filename = 'local/file.js', testName = 'case', options }: TransformAndCompileOptions = {},
): Promise<string> {
  const result = await transform(baseConfig, '/root', filename, Buffer.from(source, 'utf8'), {
    ...baseTransformOptions,
    ...options,
  });
  const code = result.output[0].data.code;
  compileWithHermes(code, testName);
  return code;
}

describe('transform worker output compiles with hermes', () => {
  type Case = [name: string, source: string, opts?: Omit<TransformAndCompileOptions, 'testName'>];
  const cases: Case[] = [
    ['trivial module', `module.exports = 42;`],
    [
      'async/await',
      `export async function load(url) {
         const res = await fetch(url);
         return res.json();
       }`,
    ],
    [
      'async generator',
      `export async function* stream() {
         yield 1;
         yield await Promise.resolve(2);
       }`,
    ],
    [
      'optional chaining + nullish coalescing',
      `export function pick(o) {
         return o?.a?.b ?? o?.c ?? "fallback";
       }`,
    ],
    [
      'logical assignment operators',
      `export function merge(a, b) {
         a.x ??= b.x;
         a.y ||= b.y;
         a.z &&= b.z;
         return a;
       }`,
    ],
    [
      'object rest/spread',
      `export function pickRest({a, ...rest}) {
         return {a, extras: {...rest, tag: 1}};
       }`,
    ],
    [
      'destructuring defaults',
      `export function parse({url = "/", headers = {}} = {}) {
         return [url, headers];
       }`,
    ],
    [
      'class with public and private fields',
      `export class Counter {
         static total = 0;
         #value = 0;
         inc() { this.#value += 1; Counter.total += 1; }
         get value() { return this.#value; }
       }`,
    ],
    [
      'private methods',
      `export class Box {
         #state = 0;
         #tick() { this.#state += 1; }
         run() { this.#tick(); return this.#state; }
       }`,
    ],
    [
      'numeric separators + BigInt',
      `export const MAX = 1_000_000;
       export const BIG = 9_007_199_254_740_993n;`,
    ],
    [
      'try/catch with optional binding',
      `export function safe(fn) {
         try { return fn(); } catch { return null; }
       }`,
    ],
    [
      'for-of / for-await-of',
      `export async function consume(iter) {
         const out = [];
         for await (const v of iter) out.push(v);
         return out;
       }`,
    ],
    [
      'template literals + tagged templates',
      `export const greet = (n) => \`hello \${n}\`;
       export const tag = (s, ...v) => s.raw.join("|") + v.join(",");`,
    ],
    [
      'exponentiation + spread args',
      `export const pow = (a, b) => a ** b;
       export const call = (fn, args) => fn(...args);`,
    ],
    [
      'regex u/y/s flags + lookbehind',
      `export const re = /(?<=\\$)\\d+/u;
       export const sticky = /ab/y;
       export const dotall = /a.b/s;`,
    ],
    [
      'JSX (automatic runtime via SWC)',
      `import React from "react";
       export function Hello({name}) {
         return <View><Text>Hi {name}</Text></View>;
       }`,
    ],
    [
      'TypeScript: type annotations + generics + enum',
      `enum Color { Red, Green, Blue }
       interface Point<T> { x: T; y: T; }
       export function mid<T extends number>(p: Point<T>): number {
         return (p.x as number) + (p.y as number);
       }
       export const first: Color = Color.Red;`,
      { filename: 'local/file.ts' },
    ],
    [
      'TSX: generic component',
      `import React from "react";
       type Props<T> = { items: T[]; render: (x: T) => React.ReactNode };
       export function List<T>({items, render}: Props<T>) {
         return <>{items.map((it, i) => <span key={i}>{render(it)}</span>)}</>;
       }`,
      { filename: 'local/file.tsx' },
    ],
    [
      'Flow types (with pragma)',
      `// @flow
       type Point = {x: number, y: number};
       export function dist(a: Point, b: Point): number {
         return Math.hypot(a.x - b.x, a.y - b.y);
       }`,
      { filename: 'local/file.js' },
    ],
    [
      'commonjs require/module.exports',
      `"use strict";
       const path = require("path");
       module.exports = function resolve(p) { return path.resolve(p); };`,
    ],
    [
      'es module import/export mix',
      `import {a, b as bb} from "./mod";
       export {a};
       export const doubled = bb * 2;
       export default function run() { return a + bb; }`,
    ],
    [
      'inline requires (options.inlineRequires=true)',
      `import mod from "./mod";
       export function use() { return mod.read(); }`,
      { options: { inlineRequires: true } },
    ],
    [
      'development minification path (dev=false, minify=true)',
      `export function shout(s) { return (s || "").toUpperCase() + "!"; }`,
      { options: { dev: false, minify: true } },
    ],
  ];

  test.each(cases)('%s', async (name, source, opts = {}) => {
    await transformAndCompile(source, {
      ...opts,
      testName: name.replace(/[^a-z0-9]+/gi, '_'),
    });
  });

  // Hermes does not support native `import()` expressions; Metro's Babel
  // transform rewrites them into `require.context`-style async helpers. Our
  // SWC pipeline currently leaves `import()` in the output, so hermesc
  // rejects it. When this is fixed the `.failing` marker should be removed.
  test.fails('dynamic import()', async () => {
    await transformAndCompile(`export const load = () => import("./mod");`, {
      testName: 'dynamic_import',
    });
  });

  // Hermes diverges from spec for `for (const x of arr)` closures: it uses
  // a single hoisted binding for the loop variable, so every closure sees
  // the final value. Expo Router tripped over this when building its route
  // map — every route's `loadRoute` closure ended up pointing at the last
  // filePath, so navigating to any route rendered the last file's component.
  //
  // `transform-block-scoping` (enabled in the worker's env.include) rewrites
  // the loop into a per-iteration helper so the closure captures the current
  // iteration's value. The transformed output must not retain a bare
  // `for (const …)` — that would be the regression shape.
  test('for (const x of …) is downleveled for Hermes per-iteration closures', async () => {
    const src = [
      `const out = [];`,
      `for (const x of ["a", "b", "c"]) {`,
      `  out.push(() => x);`,
      `}`,
      `module.exports = out.map((f) => f());`,
    ].join('\n');

    const result = await transform(
      baseConfig,
      '/root',
      'local/file.js',
      Buffer.from(src, 'utf8'),
      baseTransformOptions,
    );
    const code = result.output[0].data.code;

    // The bug shape: Hermes only respects per-iteration bindings once the
    // loop has been rewritten. A bare `for (const ...)` in the output
    // means the fix regressed.
    expect(code).not.toMatch(/for\s*\(\s*const\s+\w+\s+of\s+/);
    // Confirm the downleveling actually ran — SWC's block-scoping emits
    // either a `_loop` helper or a function-wrapped iteration.
    expect(code).toMatch(/_loop|function\s*\(\s*\w+\s*\)\s*\{[^}]*\}/);

    compileWithHermes(code, 'for_const_block_scoping');
  });
});
