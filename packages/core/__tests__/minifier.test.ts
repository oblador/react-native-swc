import { runInNewContext } from 'node:vm';

import { metroMinifier as minifier } from '../src/minify';
import { transform } from '../src/transform-worker';
import type { JsTransformerConfig, JsTransformOptions } from '../src/types';

const config: JsTransformerConfig = {
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
  minifierConfig: {},
  minifierPath: '',
  optimizationSizeLimit: 100000,
  publicPath: '/assets',
  unstable_dependencyMapReservedName: null,
  unstable_disableModuleWrapping: false,
  unstable_disableNormalizePseudoGlobals: false,
  unstable_allowRequireContext: false,
};
const options: JsTransformOptions = {
  dev: false,
  inlinePlatform: false,
  inlineRequires: false,
  minify: true,
  platform: 'ios',
  type: 'module',
  unstable_transformProfile: 'default',
};

test('public minifier preserves user-reserved names alongside Metro-reserved names', async () => {
  const result = await minifier({
    code: 'var publicValue = "東京"; var dependencyMap = [publicValue]; globalThis.answer = dependencyMap[0];',
    filename: 'module.js',
    map: null,
    reserved: ['dependencyMap'],
    config: {
      compress: false,
      mangle: { toplevel: true, reserved: ['publicValue'] },
      format: { ascii_only: false },
    },
  });
  expect(result.code).toContain('publicValue');
  expect(result.code).toContain('dependencyMap');
  expect(result.code).toContain('東京');
  const runtime: { answer?: string } = {};
  runInNewContext(result.code, runtime);
  expect(runtime.answer).toBe('東京');
});

test('public minifier honors function and class name preservation', async () => {
  const result = await minifier({
    code: 'globalThis.widget = class Widget {}; globalThis.handler = function handleEvent() {};',
    filename: 'module.js',
    map: null,
    reserved: [],
    config: { keep_classnames: true, keep_fnames: true },
  });
  const runtime: { widget?: { name: string }; handler?: { name: string } } = {};
  runInNewContext(result.code, runtime);
  expect(runtime.widget?.name).toBe('Widget');
  expect(runtime.handler?.name).toBe('handleEvent');
});

test.each(['module', 'script', 'json'] as const)(
  'honors disabled compression and mangling for %s',
  async (kind) => {
    const source =
      kind === 'json'
        ? '{"message":"東京"}'
        : 'const originalLocal = global.input; global.answer = originalLocal + 1;';
    const result = await transform(
      {
        ...config,
        minifierConfig: { compress: false, mangle: false, format: { ascii_only: true } },
      },
      '/root',
      kind === 'json' ? 'fixture.json' : 'fixture.js',
      Buffer.from(source),
      { ...options, type: kind === 'script' ? 'script' : 'module' },
    );
    const code = result.output[0].data.code;
    if (kind === 'json') {
      expect(code).toContain('module.exports');
      expect(code).not.toContain('東京');
    } else {
      expect(code).toContain('originalLocal');
      expect(code).toMatch(/global\d*\.answer/);
    }
  },
);

test('format overrides output while retaining other output options', async () => {
  const result = await minifier({
    code: '/*! preserve me */ globalThis.answer = "東京";',
    filename: 'module.js',
    map: null,
    reserved: [],
    config: { output: { comments: 'all', ascii_only: true }, format: { comments: false } },
  });
  expect(result.code).not.toContain('preserve me');
  expect(result.code).not.toContain('東京');
});
