/**
 * Ported from facebook/metro:
 *   packages/metro-transform-worker/src/__tests__/index-test.js
 * Snapshots from:
 *   packages/metro-transform-worker/src/__tests__/__snapshots__/index-test.js.snap
 *
 * Adapted for this project's SWC-based transform-worker. Some Babel-specific
 * expectations (e.g. exact `_$$_REQUIRE` headers, `minified(code)` tokens from
 * metro's mocked minifier, and Babel helper names) do not apply to our SWC
 * implementation; those tests are expected to fail until the implementation
 * catches up.
 */

import { Buffer } from 'node:buffer';
import { transformSync } from '@swc/core';
import { transform, transformRequires, collectRequireRefs } from '../src/transform-worker';
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

// ---------------------------------------------------------------------------
// collectRequireRefs / transformRequires — project-specific helper behaviour
// ---------------------------------------------------------------------------

describe('collectRequireRefs — span correctness', () => {
  const assertRefs = (code: string, expectedSpecifiers: string[]) => {
    const refs = collectRequireRefs(code);
    const buf = Buffer.from(code, 'utf8');
    for (const ref of refs) {
      const slice = buf.subarray(ref.argStart, ref.argEnd).toString('utf8');
      expect(slice === `'${ref.specifier}'` || slice === `"${ref.specifier}"`).toBe(true);
    }
    expect(refs.map((r) => r.specifier)).toEqual(expectedSpecifiers);
  };

  test('single require: span matches literal', () => {
    assertRefs(`const x = require('./foo');`, ['./foo']);
  });

  test('two requires: spans match literals', () => {
    assertRefs(`const a = require('./a');\nconst b = require('./b');`, ['./a', './b']);
  });

  test('require inside getter: span matches literal', () => {
    assertRefs(
      `module.exports = {\n  get Foo() {\n    return require('./foo').default;\n  },\n};`,
      ['./foo'],
    );
  });

  test('react-native/index.js pattern: many getters each with a require', () => {
    const modules = [
      'ActivityIndicator',
      'Button',
      'DrawerLayoutAndroid',
      'EventEmitter',
      'FlatList',
      'Image',
      'ImageBackground',
      'InputAccessoryView',
      'KeyboardAvoidingView',
      'Modal',
      'Pressable',
      'RefreshControl',
      'SafeAreaView',
      'ScrollView',
      'SectionList',
      'StatusBar',
      'Switch',
      'Text',
      'TextInput',
      'TouchableHighlight',
      'TouchableNativeFeedback',
      'TouchableOpacity',
      'View',
      'VirtualizedList',
    ];
    const code = [
      `'use strict';`,
      `Object.defineProperty(exports, "__esModule", { value: true });`,
      `const warnOnce = require('./Libraries/Utilities/warnOnce');`,
      `const invariant = require('invariant');`,
      `module.exports = {`,
      ...modules.map(
        (m) => `  get ${m}() {\n    return require('./Libraries/${m}/${m}').default;\n  },`,
      ),
      `};`,
    ].join('\n');

    const refs = collectRequireRefs(code);
    for (const ref of refs) {
      const slice = code.slice(ref.argStart, ref.argEnd);
      expect(slice === `'${ref.specifier}'` || slice === `"${ref.specifier}"`).toBe(true);
    }
    expect(refs.length).toBe(2 + modules.length);
  });

  test('2-byte UTF-8 char before require: byte offset does not drift', () => {
    assertRefs(`/* \u00A9 2024 */\nconst x = require('./foo');`, ['./foo']);
  });

  test('4-byte UTF-8 char (emoji) before require: byte offset does not drift', () => {
    assertRefs(`/* \uD83C\uDF89 emoji */\nconst x = require('./bar');`, ['./bar']);
  });

  test('non-ASCII in string literal before requires: both are replaced', () => {
    const code = `const msg = "\u00E9l\u00E9phant";\nrequire('./a');\nrequire('./b');`;
    const { code: out } = transformRequires(code);
    expect(out.includes("'./a'")).toBe(false);
    expect(out.includes("'./b'")).toBe(false);
    expect(out.includes('_dependencyMap[0]')).toBe(true);
    expect(out.includes('_dependencyMap[1]')).toBe(true);
  });

  test('anchor offsets stay correct across multiple calls', () => {
    assertRefs(`const a = require('./a');`, ['./a']);
    // Second call — no require, so parseSync is NOT called and the SWC counter
    // does not advance.
    expect(collectRequireRefs(`const x = 1;`)).toEqual([]);
    assertRefs(`const b = require('./b');\nconst c = require('./c');`, ['./b', './c']);
  });
});

describe('transformRequires + transformSync — pipeline', () => {
  test('ExceptionsManager-like pipeline: lazy require survives and .default is intact', () => {
    const source = [
      `import NativeRedBox from './NativeRedBox';`,
      `import {EventEmitter} from 'fbemitter';`,
      `import invariant from 'invariant';`,
      `import * as LogBox from './LogBox';`,
      `import React from 'react';`,
      ``,
      `function dismissRedbox() {`,
      `  if (NativeRedBox != null) {`,
      `    NativeRedBox.dismiss();`,
      `  } else {`,
      `    const NativeExceptionsManager = require('./NativeExceptionsManager').default;`,
      `    NativeExceptionsManager && NativeExceptionsManager.dismissRedbox && NativeExceptionsManager.dismissRedbox();`,
      `  }`,
      `}`,
    ].join('\n');

    const transformed = transformSync(source, {
      filename: 'ExceptionsManager.js',
      swcrc: false,
      configFile: false,
      sourceMaps: false,
      jsc: { parser: { syntax: 'ecmascript' }, externalHelpers: false },
      module: { type: 'commonjs', ignoreDynamic: true },
      isModule: true,
    }).code;

    const { code: out, dependencies } = transformRequires(transformed);

    for (const dep of dependencies) {
      expect(out.includes(`'${dep.name}'`)).toBe(false);
      expect(out.includes(`"${dep.name}"`)).toBe(false);
    }
    expect(dependencies.some((d) => d.name === './NativeExceptionsManager')).toBe(true);
    expect(out.includes(`).default`)).toBe(true);
    for (const [, idx] of out.matchAll(/_dependencyMap\[(\d+)\]/g)) {
      expect(Number(idx)).toBeLessThan(dependencies.length);
    }
  });
});

describe('transformRequires — output correctness', () => {
  test('single require is replaced with _dependencyMap index', () => {
    const { code, dependencies } = transformRequires(`require('./foo');`);
    expect(code).toBe(`require(_dependencyMap[0]);`);
    expect(dependencies.length).toBe(1);
    expect(dependencies[0].name).toBe('./foo');
  });

  test('two requires get sequential indices', () => {
    const input = `const a = require('./a');\nconst b = require('./b');`;
    const { code, dependencies } = transformRequires(input);
    expect(code).toBe(
      `const a = require(_dependencyMap[0]);\nconst b = require(_dependencyMap[1]);`,
    );
    expect(dependencies.length).toBe(2);
  });

  test('duplicate specifier shares an index', () => {
    const input = `require('./a');\nrequire('./a');`;
    const { code, dependencies } = transformRequires(input);
    expect(code).toBe(`require(_dependencyMap[0]);\nrequire(_dependencyMap[0]);`);
    expect(dependencies.length).toBe(1);
  });

  test('getter pattern', () => {
    const input = [
      `module.exports = {`,
      `  get Foo() { return require('./foo').default; },`,
      `  get Bar() { return require('./bar').default; },`,
      `};`,
    ].join('\n');
    const { code, dependencies } = transformRequires(input);
    expect(code.includes(`require(_dependencyMap[0])`)).toBe(true);
    expect(code.includes(`require(_dependencyMap[1])`)).toBe(true);
    expect(code.includes(`'./foo'`)).toBe(false);
    expect(code.includes(`'./bar'`)).toBe(false);
    expect(dependencies.length).toBe(2);
  });

  test('large react-native/index.js-like file: no position drift', () => {
    const modules = [
      'ActivityIndicator',
      'Button',
      'DrawerLayoutAndroid',
      'EventEmitter',
      'FlatList',
      'Image',
      'ImageBackground',
      'InputAccessoryView',
      'KeyboardAvoidingView',
      'Modal',
      'Pressable',
      'RefreshControl',
      'SafeAreaView',
      'ScrollView',
      'SectionList',
      'StatusBar',
      'Switch',
      'Text',
      'TextInput',
      'TouchableHighlight',
      'TouchableNativeFeedback',
      'TouchableOpacity',
      'View',
      'VirtualizedList',
    ];
    const code = [
      `'use strict';`,
      `Object.defineProperty(exports, "__esModule", { value: true });`,
      `const warnOnce = require('./Libraries/Utilities/warnOnce');`,
      `const invariant = require('invariant');`,
      `module.exports = {`,
      ...modules.map(
        (m) => `  get ${m}() {\n    return require('./Libraries/${m}/${m}').default;\n  },`,
      ),
      `};`,
    ].join('\n');

    const { code: out, dependencies } = transformRequires(code);

    for (const m of modules) {
      expect(out.includes(`'./Libraries/${m}/${m}'`)).toBe(false);
    }
    const depRefs = [...out.matchAll(/_dependencyMap\[(\d+)\]/g)];
    for (const [, idx] of depRefs) {
      expect(Number(idx)).toBeLessThan(dependencies.length);
    }
    expect(dependencies.length).toBe(26);
  });

  test('require.context is only transformed when explicitly enabled', () => {
    const input = `const ctx = require.context('./images', false, /\\.png$/, 'lazy');`;
    const disabled = transformRequires(input);
    expect(disabled.code).toBe(input);
    expect(disabled.dependencies.length).toBe(0);

    const enabled = transformRequires(input, { allowRequireContext: true });
    expect(enabled.code).toBe(`const ctx = require(_dependencyMap[0]);`);
    expect(enabled.dependencies.length).toBe(1);
    expect(enabled.dependencies[0].name).toBe('./images');
    expect(enabled.dependencies[0].data.asyncType).toBeNull();
    expect(enabled.dependencies[0].data.isOptional).toBe(false);
    expect(enabled.dependencies[0].data.contextParams).toEqual({
      recursive: false,
      filter: { pattern: '\\.png$', flags: '' },
      mode: 'lazy',
    });
  });

  test('require.context inside try/catch is marked optional', () => {
    const input = `
try {
  const ctx = require.context('./screens');
} catch (e) {}
`;
    const out = transformRequires(input, { allowRequireContext: true });
    expect(out.dependencies.length).toBe(1);
    expect(out.dependencies[0].data.isOptional).toBe(true);
    expect(out.dependencies[0].data.contextParams).toEqual({
      recursive: true,
      filter: { pattern: '.*', flags: '' },
      mode: 'sync',
    });
  });

  test('distinct context params produce distinct dependencies', () => {
    const input = `
const a = require.context('./ctx', false, /\\.png$/);
const b = require.context('./ctx', true, /\\.jpg$/);
`;
    const out = transformRequires(input, { allowRequireContext: true });
    expect(out.dependencies.length).toBe(2);
    expect(out.dependencies[0].data.key).not.toBe(out.dependencies[1].data.key);
  });

  test('Expo Router form with process.env placeholders', () => {
    const input = `
export const ctx = require.context(
  process.env.EXPO_ROUTER_APP_ROOT,
  true,
  /^(?:\\.\\/)(?!(?:(?:(?:.*\\+api)|(?:\\+html)|(?:\\+middleware)))\\.[tj]sx?$).*(?:\\.android|\\.web)?\\.[tj]sx?$/,
  process.env.EXPO_ROUTER_IMPORT_MODE
);
`;

    const out = transformRequires(input, {
      allowRequireContext: true,
      envValues: {
        EXPO_ROUTER_APP_ROOT: './app',
        EXPO_ROUTER_IMPORT_MODE: 'lazy',
      },
    });

    expect(out.dependencies.length).toBe(1);
    expect(out.dependencies[0].name).toBe('./app');
    expect(out.dependencies[0].data.contextParams?.recursive).toBe(true);
    expect(out.dependencies[0].data.contextParams?.mode).toBe('lazy');
    expect(out.code.includes('require(_dependencyMap[0])')).toBe(true);
  });

  test('dynamic import() rewrites to the asyncRequire helper form', () => {
    const input = `const m = import("./foo");`;
    const out = transformRequires(input, { asyncRequireModulePath: 'asyncRequire' });

    // Slot 0 is the asyncRequire helper; slot 1 is the imported specifier.
    expect(out.code).toBe(
      `const m = require(_dependencyMap[0])(_dependencyMap[1], _dependencyMap.paths);`,
    );
    expect(out.dependencies).toHaveLength(2);
    expect(out.dependencies[0].name).toBe('asyncRequire');
    expect(out.dependencies[0].data.asyncType).toBeNull();
    expect(out.dependencies[0].data.isESMImport).toBe(false);
    expect(out.dependencies[1].name).toBe('./foo');
    expect(out.dependencies[1].data.asyncType).toBe('async');
    expect(out.dependencies[1].data.isESMImport).toBe(true);
  });

  test('dynamic import() and same-name require() produce distinct deps', () => {
    const input = `const a = require("./foo"); const b = import("./foo");`;
    const out = transformRequires(input, { asyncRequireModulePath: 'asyncRequire' });

    expect(out.dependencies.map((d) => ({ name: d.name, asyncType: d.data.asyncType }))).toEqual([
      // Static require collected before import call: helper slot is allocated
      // first when buildDependencyList is processed, but the static require is
      // visited first by collectRequireRefs — order matters for the dep list.
      { name: 'asyncRequire', asyncType: null },
      { name: './foo', asyncType: null },
      { name: './foo', asyncType: 'async' },
    ]);
    expect(out.code).toBe(
      `const a = require(_dependencyMap[1]); const b = require(_dependencyMap[0])(_dependencyMap[2], _dependencyMap.paths);`,
    );
  });

  test('dynamic import() with non-literal argument throws at build time', async () => {
    await expect(
      transform(
        baseConfig,
        '/root',
        'local/file.js',
        Buffer.from(`const m = import(name);`, 'utf8'),
        baseTransformOptions,
      ),
    ).rejects.toThrow(/Dynamic require is not supported.*import\(\) call/);
  });

  test('repeated import() of the same specifier shares one dep slot', () => {
    const input = `const a = import("./foo"); const b = import("./foo");`;
    const out = transformRequires(input, { asyncRequireModulePath: 'asyncRequire' });
    expect(out.dependencies.map((d) => d.name)).toEqual(['asyncRequire', './foo']);
  });

  test('require() with a no-substitution template literal is treated as static', () => {
    const input = 'const x = require(`/assets/image.png`);';
    const { code, dependencies } = transformRequires(input);
    expect(code).toBe('const x = require(_dependencyMap[0]);');
    expect(dependencies.map((d) => d.name)).toEqual(['/assets/image.png']);
  });

  test('require() with an interpolated template literal is still dynamic', async () => {
    await expect(
      transform(
        baseConfig,
        '/root',
        'local/file.js',
        Buffer.from('const x = require(`/assets/${name}.png`);', 'utf8'),
        baseTransformOptions,
      ),
    ).rejects.toThrow(/Dynamic require is not supported.*require\(\) call/);
  });

  test('import() with a no-substitution template literal is treated as static', () => {
    const input = 'const m = import(`./foo`);';
    const out = transformRequires(input, { asyncRequireModulePath: 'asyncRequire' });
    expect(out.code).toBe(
      'const m = require(_dependencyMap[0])(_dependencyMap[1], _dependencyMap.paths);',
    );
    expect(out.dependencies.map((d) => d.name)).toEqual(['asyncRequire', './foo']);
  });
});

// ---------------------------------------------------------------------------
// transform() — direct port of metro-transform-worker index-test.js
// ---------------------------------------------------------------------------

test('transforms a simple script', async () => {
  const result = await transform(
    baseConfig,
    '/root',
    'local/file.js',
    Buffer.from('someReallyArbitrary(code)', 'utf8'),
    { ...baseTransformOptions, type: 'script' },
  );

  expect(result.output[0].type).toBe('js/script');
  expect(result.output[0].data.code).toMatchSnapshot();
  expect(result.output[0].data.code).toMatch(/^\(function\s*\(global\)/);
  expect(result.output[0].data.code).toContain('someReallyArbitrary(code)');
  expect(result.output[0].data.code).toContain('typeof globalThis');
  expect(result.output[0].data.map).toMatchSnapshot();
  expect(result.output[0].data.functionMap).toMatchSnapshot();
  expect(result.dependencies).toEqual([]);
});

test('transforms a simple module', async () => {
  const result = await transform(
    baseConfig,
    '/root',
    'local/file.js',
    Buffer.from('arbitrary(code)', 'utf8'),
    baseTransformOptions,
  );

  expect(result.output[0].type).toBe('js/module');
  expect(result.output[0].data.code).toMatchSnapshot();
  expect(result.output[0].data.code).toMatch(/^__d\(function\s*\(/);
  expect(result.output[0].data.code).toContain('arbitrary(code)');
  expect(result.output[0].data.map).toMatchSnapshot();
  expect(result.output[0].data.functionMap).toMatchSnapshot();
  expect(result.dependencies).toEqual([]);
});

test('transforms a module with dependencies', async () => {
  // Note: the ESM `import c` is tracked as a dependency and rewritten to a
  // `_$$_IMPORT_DEFAULT(_dependencyMap[N], "./c")` helper call — matching
  // Metro's Babel `importExportPlugin` output. The second argument is a
  // diagnostic specifier the runtime uses for error messages only.
  const contents = [
    '"use strict";',
    'require("./a");',
    'arbitrary(code);',
    'const b = require("b");',
    'import c from "./c";',
  ].join('\n');

  const result = await transform(
    baseConfig,
    '/root',
    'local/file.js',
    Buffer.from(contents, 'utf8'),
    baseTransformOptions,
  );

  expect(result.output[0].type).toBe('js/module');
  const code = result.output[0].data.code;
  expect(code).toMatchSnapshot();
  expect(code).toContain('arbitrary(code)');
  expect(code).toContain('_dependencyMap[0]');
  expect(code).toContain('_dependencyMap[1]');
  expect(code).toContain('_dependencyMap[2]');
  // The `require(...)` argument for resolved deps must be rewritten — only
  // the `_$$_IMPORT_*` helper's diagnostic second arg keeps the specifier.
  expect(code).not.toMatch(/require\([^)]*"\.\/a"/);
  expect(code).not.toMatch(/require\([^)]*"b"/);
  expect(code).not.toMatch(/require\([^)]*"\.\/c"/);
  expect(result.output[0].data.map).toMatchSnapshot();
  expect(result.output[0].data.functionMap).toMatchSnapshot();
  // Imports are hoisted above the rest of the module body (ESM semantics),
  // so `import c from "./c"` — the only `import` in the source — becomes
  // the first dependency; the `require("./a")` and `require("b")` CJS calls
  // that live inside the body follow it in source order.
  expect(result.dependencies.map((d) => d.name)).toEqual(['./c', './a', 'b']);
  for (const dep of result.dependencies) {
    expect(dep.data).toEqual(expect.objectContaining({ asyncType: null }));
  }
});

test('transforms an es module with asyncToGenerator', async () => {
  // SWC inlines asyncToGenerator helpers rather than requiring them from
  // `@babel/runtime`, so the dependency list is empty.
  const result = await transform(
    baseConfig,
    '/root',
    'local/file.js',
    Buffer.from('export async function test() {}', 'utf8'),
    baseTransformOptions,
  );

  expect(result.output[0].type).toBe('js/module');
  expect(result.output[0].data.code).toMatchSnapshot();
  expect(result.output[0].data.code).toMatch(/_async_to_generator|asyncGeneratorStep/);
  expect(Array.isArray(result.output[0].data.map)).toBe(true);
  expect(result.output[0].data.functionMap).toMatchSnapshot();
  expect(result.dependencies).toEqual([]);
});

test('transforms async generators', async () => {
  // SWC inlines wrapAsyncGenerator helpers; no @babel/runtime deps are emitted.
  const result = await transform(
    baseConfig,
    '/root',
    'local/file.js',
    Buffer.from('export async function* test() { yield "ok"; }', 'utf8'),
    baseTransformOptions,
  );

  expect(result.output[0].data.code).toMatchSnapshot();
  expect(result.output[0].data.code).toMatch(
    /_async_generator|_wrap_async_generator|asyncGeneratorStep/,
  );
  expect(result.dependencies).toEqual([]);
});

test('transforms import/export syntax when experimental flag is on', async () => {
  const contents = ['import c from "./c";'].join('\n');

  const result = await transform(
    baseConfig,
    '/root',
    'local/file.js',
    Buffer.from(contents, 'utf8'),
    { ...baseTransformOptions, experimentalImportSupport: true },
  );

  expect(result.output[0].type).toBe('js/module');
  const code = result.output[0].data.code;
  expect(code).toMatchSnapshot();
  expect(code).toContain('var c = _$$_IMPORT_DEFAULT(_dependencyMap[0], "./c")');
  expect(result.output[0].data.map).toMatchSnapshot();
  expect(result.output[0].data.functionMap).toMatchSnapshot();
  expect(result.dependencies).toEqual([
    {
      data: expect.objectContaining({
        asyncType: null,
      }),
      name: './c',
    },
  ]);
});

test('does not add "use strict" on non-modules', async () => {
  // The SWC transformer currently emits a `"use strict"` directive inside the
  // module factory regardless of whether the source file lives in
  // `node_modules/`. This diverges from metro's Babel-based behavior, which
  // treats files under `node_modules` as non-modules and does not add the
  // directive.
  const result = await transform(
    baseConfig,
    '/root',
    'node_modules/local/file.js',
    Buffer.from('module.exports = {};', 'utf8'),
    { ...baseTransformOptions, experimentalImportSupport: true },
  );

  expect(result.output[0].type).toBe('js/module');
  const code = result.output[0].data.code;
  expect(code).toMatchSnapshot();
  expect(code).toContain('module.exports = {}');
});

test('preserves require() calls when module wrapping is disabled', async () => {
  // When module wrapping is disabled there is no surrounding factory to
  // supply a `_dependencyMap` binding, so metro leaves `require("./c")` as-is.
  // The current SWC-based implementation still performs the dep-map rewrite
  // and emits `require(_dependencyMap[0])`, which would fail at runtime without
  // a user-provided binding. This test pins the current behaviour so it is
  // easy to spot when the implementation catches up.
  const contents = ['require("./c");'].join('\n');

  const result = await transform(
    {
      ...baseConfig,
      unstable_disableModuleWrapping: true,
    },
    '/root',
    'local/file.js',
    Buffer.from(contents, 'utf8'),
    baseTransformOptions,
  );

  expect(result.output[0].type).toBe('js/module');
  expect(result.output[0].data.code).toMatchSnapshot();
  expect(result.output[0].data.code).not.toContain('__d(');
});

test('reports filename when encountering unsupported dynamic dependency', async () => {
  const contents = ['require("./a");', 'let a = arbitrary(code);', 'const b = require(a);'].join(
    '\n',
  );

  try {
    await transform(
      baseConfig,
      '/root',
      'local/file.js',
      Buffer.from(contents, 'utf8'),
      baseTransformOptions,
    );
    throw new Error('should not reach this');
  } catch (error) {
    expect((error as Error).message).toMatchSnapshot();
  }
});

test('supports dynamic dependencies from within `node_modules`', async () => {
  const result = await transform(
    {
      ...baseConfig,
      dynamicDepsInPackages: 'throwAtRuntime',
    },
    '/root',
    'node_modules/foo/bar.js',
    Buffer.from('require(foo.bar);', 'utf8'),
    baseTransformOptions,
  );

  const code = result.output[0].data.code;
  expect(code).toMatchSnapshot();
  expect(code).toContain('Dynamic require defined at line');
  expect(code).toContain('not supported by Metro');
  // The throw-at-runtime wrapper is an IIFE that passes the source line number.
  expect(code).toMatch(/\}\)\(\d+\)/);
});

test('minifies the code correctly', async () => {
  // Metro's upstream test mocks the minifier to rewrite `arbitrary(code)` to
  // `minified(code)`. We run the real SWC minifier, so we assert on the
  // properties that actually hold: compact output with the source expression
  // preserved and the factory params mangled by the minifier.
  const result = await transform(
    baseConfig,
    '/root',
    'local/file.js',
    Buffer.from('arbitrary(code);', 'utf8'),
    { ...baseTransformOptions, minify: true },
  );
  const code = result.output[0].data.code;
  expect(code).toMatchSnapshot();
  expect(code).not.toContain('\n');
  expect(code).toContain('arbitrary(code)');
  // The SWC minifier renames each factory param to a short identifier.
  expect(code).toMatch(/^__d\(function\([a-z_](?:,[a-z_]){6}\)/);
});

test('minifies a JSON file', async () => {
  const result = await transform(
    baseConfig,
    '/root',
    'local/file.json',
    Buffer.from('arbitrary(code);', 'utf8'),
    { ...baseTransformOptions, minify: true },
  );
  const code = result.output[0].data.code;
  expect(code).toMatchSnapshot();
  expect(code).not.toContain('\n');
  expect(code).toMatch(/\bexports\s*=\s*arbitrary\(code\)/);
});

test('does not wrap a JSON file when disableModuleWrapping is enabled', async () => {
  expect(
    (
      await transform(
        {
          ...baseConfig,
          unstable_disableModuleWrapping: true,
        },
        '/root',
        'local/file.json',
        Buffer.from('arbitrary(code);', 'utf8'),
        baseTransformOptions,
      )
    ).output[0].data.code,
  ).toBe('module.exports = arbitrary(code);;');
});

test('uses a reserved dependency map name and prevents it from being minified', async () => {
  const result = await transform(
    { ...baseConfig, unstable_dependencyMapReservedName: 'THE_DEP_MAP' },
    '/root',
    'local/file.js',
    Buffer.from('arbitrary(code);', 'utf8'),
    { ...baseTransformOptions, dev: false, minify: true },
  );
  expect(result.output[0].data.code).toMatchInlineSnapshot(
    `"__d(function(r,t,_,c,i,a,THE_DEP_MAP){"use strict";arbitrary(code)});"`,
  );
});

test('throws if the reserved dependency map name appears in the input', async () => {
  await expect(
    transform(
      { ...baseConfig, unstable_dependencyMapReservedName: 'THE_DEP_MAP' },
      '/root',
      'local/file.js',
      Buffer.from(
        'arbitrary(code); /* the code is not allowed to mention THE_DEP_MAP, even in a comment */',
        'utf8',
      ),
      { ...baseTransformOptions, dev: false, minify: true },
    ),
  ).rejects.toThrowErrorMatchingInlineSnapshot(
    `[SyntaxError: Source code contains the reserved string \`THE_DEP_MAP\` at character offset 55]`,
  );
});

test('skips minification in Hermes stable transform profile', async () => {
  const result = await transform(
    baseConfig,
    '/root',
    'local/file.js',
    Buffer.from('arbitrary(code);', 'utf8'),
    {
      ...baseTransformOptions,
      dev: false,
      minify: true,
      unstable_transformProfile: 'hermes-canary',
    },
  );
  expect(result.output[0].data.code).toMatchInlineSnapshot(`
"__d(function(global, require, _$$_IMPORT_DEFAULT, _$$_IMPORT_ALL, module, exports, _dependencyMap) {
"use strict";
arbitrary(code);

});"
`);
});

test('skips minification in Hermes canary transform profile', async () => {
  const result = await transform(
    baseConfig,
    '/root',
    'local/file.js',
    Buffer.from('arbitrary(code);', 'utf8'),
    {
      ...baseTransformOptions,
      dev: false,
      minify: true,
      unstable_transformProfile: 'hermes-canary',
    },
  );
  expect(result.output[0].data.code).toMatchInlineSnapshot(`
"__d(function(global, require, _$$_IMPORT_DEFAULT, _$$_IMPORT_ALL, module, exports, _dependencyMap) {
"use strict";
arbitrary(code);

});"
`);
});

test('counts all line endings correctly', async () => {
  const transformStr = (str: string) =>
    transform(baseConfig, '/root', 'local/file.js', Buffer.from(str, 'utf8'), {
      ...baseTransformOptions,
      dev: false,
      minify: false,
    });

  const differentEndingsResult = await transformStr('one\rtwo\r\nthree\nfour\u2028five\u2029six');

  const standardEndingsResult = await transformStr('one\ntwo\nthree\nfour\nfive\nsix');

  expect(differentEndingsResult.output[0].data.lineCount).toEqual(
    standardEndingsResult.output[0].data.lineCount,
  );
});

test('outputs comments when `minify: false`', async () => {
  const result = await transform(
    baseConfig,
    '/root',
    'local/file.js',
    Buffer.from('/*#__PURE__*/arbitrary(code);', 'utf8'),
    { ...baseTransformOptions, dev: false, minify: false },
  );
  expect(result.output[0].data.code).toMatchInlineSnapshot(`
"__d(function(global, require, _$$_IMPORT_DEFAULT, _$$_IMPORT_ALL, module, exports, _dependencyMap) {
"use strict";
/*#__PURE__*/ arbitrary(code);

});"
`);
});

test('omits comments when `minify: true`', async () => {
  const result = await transform(
    baseConfig,
    '/root',
    'local/file.js',
    Buffer.from('/*#__PURE__*/arbitrary(code);', 'utf8'),
    { ...baseTransformOptions, dev: false, minify: true },
  );
  // SWC's minifier sees `/*#__PURE__*/arbitrary(code)` as a pure call with
  // an unused return and tree-shakes it to just `code` (the argument, which
  // may still have side effects). The PURE annotation is dropped along
  // with the call in this path because comments are stripped entirely.
  expect(result.output[0].data.code).toMatchInlineSnapshot(
    `"__d(function(c,t,d,e,i,n,o){"use strict";code});"`,
  );
});

test('allows outputting comments when `minify: true`', async () => {
  const result = await transform(
    { ...baseConfig, minifierConfig: { output: { comments: true } } },
    '/root',
    'local/file.js',
    Buffer.from('/*#__PURE__*/arbitrary(code);', 'utf8'),
    { ...baseTransformOptions, dev: false, minify: true },
  );
  expect(result.output[0].data.code).toMatchInlineSnapshot(
    `"__d(function(c,t,d,e,i,n,o){"use strict";/*#__PURE__*/code});"`,
  );
});

test('forwards user `minifierConfig.mangle: false` to SWC', async () => {
  // The minifier wrapper is a thin terser→SWC translator. Sanity-check
  // that a flag the user passes via `minifierConfig` actually reaches
  // SWC and changes its output — i.e. the translator isn't silently
  // dropping the user's keys. `mangle: false` is the cleanest signal:
  // mangling renames local identifiers like `arbitraryLocalVar` to a
  // single letter, so disabling it keeps the original name in the
  // output.
  const src = [
    `export function f(arbitraryLocalVar) {`,
    `  const anotherLocalVar = arbitraryLocalVar + 1;`,
    `  return anotherLocalVar;`,
    `}`,
  ].join('\n');

  const withMangleOff = await transform(
    { ...baseConfig, minifierConfig: { output: { comments: false }, mangle: false } },
    '/root',
    'local/file.js',
    Buffer.from(src, 'utf8'),
    { ...baseTransformOptions, dev: false, minify: true },
  );
  // With mangle off, parameter names AND the module factory's parameter
  // names (`global`, `require`, `_dependencyMap`, …) survive verbatim.
  expect(withMangleOff.output[0].data.code).toContain('arbitraryLocalVar');
  expect(withMangleOff.output[0].data.code).toContain('_dependencyMap');

  // Sanity: under the default config the same names get mangled away.
  const baseline = await transform(baseConfig, '/root', 'local/file.js', Buffer.from(src, 'utf8'), {
    ...baseTransformOptions,
    dev: false,
    minify: true,
  });
  expect(baseline.output[0].data.code).not.toContain('arbitraryLocalVar');
  expect(baseline.output[0].data.code).not.toContain('_dependencyMap');
});

test("translates upstream Metro's default `minifierConfig` to SWC options", async () => {
  // The exact `minifierConfig` block Metro ships in `metro-config`'s
  // DEFAULT_METRO_CONFIG (facebook/metro
  // packages/metro-config/src/defaults/index.js). It targets
  // `metro-minify-terser`; the wrapper in `minify.ts` translates terser-
  // shape options (`output` → `format`; `mangle.reserved` augmented;
  // `compress` / `mangle` / `toplevel` forwarded by name) into what
  // `@swc/core` expects. This test pins the contract that passing the
  // block verbatim is a non-event:
  //
  //   1. The translator must not throw on terser-only keys like
  //      `output.quote_style` / `output.wrap_iife` / `output.ascii_only`
  //      (all currently noop in SWC per `@swc/types/index.d.ts`).
  //   2. `sourceMap.includeSources` lives at the top level; the worker
  //      drives sourcemaps independently and must ignore it cleanly.
  //   3. The result must still be a valid Metro module wrapper.
  //
  // The flag-effect side of the contract — that user keys actually reach
  // SWC and aren't dropped on the floor — is covered by the `mangle:
  // false` test below. This one only catches "passing Metro's exact
  // defaults breaks the translator", which the previous regex-rename of
  // `output → format` could have introduced.
  const metroDefaultMinifierConfig = {
    mangle: { toplevel: false },
    output: { ascii_only: true, quote_style: 3, wrap_iife: true },
    sourceMap: { includeSources: false },
    toplevel: false,
    compress: { reduce_funcs: false },
  };

  const src = [`'use strict';`, `module.exports = function add(a, b) { return a + b; };`].join(
    '\n',
  );

  const result = await transform(
    { ...baseConfig, minifierConfig: metroDefaultMinifierConfig },
    '/root',
    'local/file.js',
    Buffer.from(src, 'utf8'),
    { ...baseTransformOptions, dev: false, minify: true },
  );

  const code = result.output[0].data.code;
  // Wrapped as a Metro factory (no parser error, no SWC option error).
  expect(code).toMatch(/^__d\(function\(/);
  // The module body survived: an `exports = function(…){return …}`
  // assignment is recognisable through mangling.
  expect(code).toMatch(/=function\([^)]*\)\{return /);
});

test('honours `minifierConfig.compress: false` to skip the compress pass', async () => {
  // Source: a top-level helper function with a single call site at the
  // module's exported entry point. With default compress, SWC inlines the
  // helper into the caller via a `let X; … return X = {…}, callee(…)`
  // closure-capture trick. The escape hatch lets users opt that out
  // wholesale when the inlined shape trips a downstream runtime (we hit
  // this with Hermes' generator implementation for an async helper that
  // had its only call site inside another async function — closure-
  // captured `let` bindings re-read across a yield boundary read as
  // undefined).
  const src = [
    `function inner(args) {`,
    `  return args.x + args.y;`,
    `}`,
    `export function outer(x, y) {`,
    `  return inner({ x, y });`,
    `}`,
  ].join('\n');

  const countFns = (code: string) => (code.match(/\bfunction\s+\w+\s*\(/g) ?? []).length;

  const withCompress = await transform(
    baseConfig,
    '/root',
    'local/file.js',
    Buffer.from(src, 'utf8'),
    { ...baseTransformOptions, dev: false, minify: true },
  );
  // Default compress folds `inner` away — only `outer` survives as a
  // named function declaration.
  expect(countFns(withCompress.output[0].data.code)).toBe(1);

  const withoutCompress = await transform(
    { ...baseConfig, minifierConfig: { output: { comments: false }, compress: false } },
    '/root',
    'local/file.js',
    Buffer.from(src, 'utf8'),
    { ...baseTransformOptions, dev: false, minify: true },
  );
  // With `compress: false`, both `inner` and `outer` survive (mangle
  // renames them but the function declarations are still there). This is
  // the shape users want when SWC's default compress is too aggressive
  // for their target runtime.
  expect(countFns(withoutCompress.output[0].data.code)).toBe(2);
});

// ---------------------------------------------------------------------------
// Worklets plugin × ESM→CJS — regression tests
// ---------------------------------------------------------------------------

// The worklets SWC plugin is not bundled with the transform worker; it is
// opt-in via `transformer.swcConfig`. Tests that exercise worklet
// transformations must pass it through here.
const baseConfigWithWorklets: JsTransformerConfig = {
  ...baseConfig,
  swcConfig: {
    plugins: [['@react-native-swc/worklets-plugin', {}]],
  },
};

// When a worklet captures an imported binding, the plugin emits a factory
// IIFE whose argument list forwards the captured value. Historically the
// plugin emitted `{ RuntimeKind }` shorthand with an empty SyntaxContext,
// which SWC's later ESM→CJS pass left untouched — producing a bare
// reference to a nonexistent top-level `RuntimeKind` and a Hermes runtime
// crash ("Property RuntimeKind doesn't exist") as soon as the factory ran
// at module init. The fix preserves the ctxt on closure idents and emits
// explicit key-value pairs so the value expression goes through normal
// import rewriting.
test('worklet factory forwards imports as module-scoped references', async () => {
  const src = [
    `'use strict';`,
    `import { RuntimeKind } from 'react-native-worklets';`,
    `export function registerReanimatedError() {`,
    `  'worklet';`,
    `  if (globalThis.__RUNTIME_KIND !== RuntimeKind.ReactNative) {`,
    `    globalThis.x = 1;`,
    `  }`,
    `}`,
  ].join('\n');

  const result = await transform(
    baseConfigWithWorklets,
    '/root',
    'errors.ts',
    Buffer.from(src, 'utf8'),
    baseTransformOptions,
  );
  const code = result.output[0].data.code;

  // Factory IIFE argument must resolve `RuntimeKind` via the import — either
  // the bare local (when a top-level `var RuntimeKind = require(...).RuntimeKind`
  // survives) or an inlined `require(...).RuntimeKind` when inline-requires is
  // active. Both prove the binding isn't dangling.
  expect(code).toMatch(/RuntimeKind:\s*(?:require\([^)]+\)\.RuntimeKind|RuntimeKind)\b/);
  expect(code).toMatch(/var\s+RuntimeKind\s*=\s*require\([^)]+\)\.RuntimeKind/);
  // Sanity: the dangling-shorthand regression shape must not reappear.
  expect(code).not.toMatch(/\}\(\{\s*[^}]*,\s*RuntimeKind,/);
});

// A named function expression (`function F(param){ ... }`) binds `F` only
// inside its own body. When one worklet contains another, the closure
// collector used to visit the inner FnExpr's `.ident` as a reference,
// leaking the inner factory's self-name (e.g. `pnpm_runtimesTs2Factory`)
// into the outer worklet's closure destructuring — producing a runtime
// `ReferenceError: Property '…Factory' doesn't exist` at launch.
test('nested worklet IIFE factory names do not leak into outer closure', async () => {
  const src = [
    `'use strict';`,
    `import { createSerializable } from 'react-native-worklets';`,
    `export function runOnRuntime(worklet) {`,
    `  'worklet';`,
    `  return (...args) => {`,
    `    createSerializable(() => {`,
    `      'worklet';`,
    `      worklet(...args);`,
    `    });`,
    `  };`,
    `}`,
  ].join('\n');

  const result = await transform(
    baseConfigWithWorklets,
    '/root',
    'runtimes.ts',
    Buffer.from(src, 'utf8'),
    baseTransformOptions,
  );
  const code = result.output[0].data.code;

  // The outer factory's closure-destructuring `{...} = param` must not
  // list any inner `*Factory` name (those are FnExpr self-names that bind
  // only inside their own body). `transform-block-scoping` rewrites `let`
  // to `var`, so match either.
  const destructure = code.match(/\b(?:let|var)\s*\{[^}]*\}\s*=\s*param;/);
  expect(destructure).not.toBeNull();
  expect(destructure![0]).not.toMatch(/\w+Factory\b/);
  // And the outer factory's IIFE call argument must not forward one.
  const iifeCall = code.match(/\}\(\{[^}]*\}\);/g);
  expect(iifeCall).not.toBeNull();
  expect(iifeCall!.join('\n')).not.toMatch(/\w+Factory\b/);
});

// Original bug: when the plugin replaces `function F() { 'worklet'; ... }`
// with `const F = factory(...)`, emitting the new `F` binding with a fresh
// empty SyntaxContext orphaned every existing `F` reference (SWC could no
// longer match them, renamed one side, and the other went undefined).
// Keeping the original ident's ctxt on the replacement binding fixes it.
test('worklet fn_decl replacement keeps subsequent references live', async () => {
  const src = [
    `'use strict';`,
    `function ReanimatedErrorConstructor(message) {`,
    `  'worklet';`,
    `  return new Error(message);`,
    `}`,
    `export const ReanimatedError = ReanimatedErrorConstructor;`,
  ].join('\n');

  const result = await transform(
    baseConfigWithWorklets,
    '/root',
    'errors.ts',
    Buffer.from(src, 'utf8'),
    baseTransformOptions,
  );
  const code = result.output[0].data.code;

  // The final export assignment must still reference the transformed const
  // (block-scoping rewrites `const`/`let` to `var`, so accept both).
  expect(code).toMatch(/\b(?:const|var) ReanimatedError\s*=\s*ReanimatedErrorConstructor\b/);
  // And there must be a matching top-level `ReanimatedErrorConstructor`
  // declaration — not a renamed `ReanimatedErrorConstructor1`.
  expect(code).toMatch(/\b(?:const|var) ReanimatedErrorConstructor\s*=\s*function/);
  expect(code).not.toMatch(/\b(?:const|var) ReanimatedErrorConstructor1\s*=/);
});
