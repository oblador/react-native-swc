import { Buffer } from 'node:buffer';
import { resolve } from 'node:path';
import type { MetroConfig } from 'metro-config';

import { getCacheKey, transform } from '../src/transform-worker';
import type { JsTransformerConfig, JsTransformOptions } from '../src/types';
import { getUpstreamTransformerPath } from '../src/upstream';

const upstreamPath = resolve(__dirname, 'fixtures/upstream-transform-worker.js');

type UpstreamCall = {
  config: JsTransformerConfig;
  projectRoot: string;
  filename: string;
  data: Buffer;
  options: JsTransformOptions;
};

const upstreamCalls = (): UpstreamCall[] =>
  ((globalThis as { __upstreamTransformCalls?: UpstreamCall[] }).__upstreamTransformCalls ??= []);

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

const upstreamConfig: JsTransformerConfig = {
  ...baseConfig,
  swcUpstreamTransformerPath: upstreamPath,
};

beforeEach(() => {
  upstreamCalls().length = 0;
});

// `withSwcTransformer` itself can't run here: rstest bundles `src/index.ts`,
// so its `require.resolve('./transform-worker')` resolves from this file.
describe('getUpstreamTransformerPath', () => {
  const ownPath = '/pkg/dist/transform-worker.js';

  test('records the transformerPath being replaced', () => {
    expect(getUpstreamTransformerPath({ transformerPath: upstreamPath }, ownPath)).toBe(
      upstreamPath,
    );
  });

  test("does not record Metro's default worker", () => {
    expect(
      getUpstreamTransformerPath({ transformerPath: 'metro-transform-worker' }, ownPath),
    ).toBeUndefined();
  });

  test('carries the original upstream forward when wrapped twice', () => {
    const wrapped = {
      transformerPath: ownPath,
      transformer: { swcUpstreamTransformerPath: upstreamPath },
    } as MetroConfig;
    expect(getUpstreamTransformerPath(wrapped, ownPath)).toBe(upstreamPath);
  });
});

describe('transform — CSS delegation', () => {
  test.each(['global.css', 'button.module.css', 'theme.scss', 'theme.sass'])(
    'delegates %s to the upstream worker unchanged',
    async (filename) => {
      const data = Buffer.from(':root { --a: 1px; }');
      const result = await transform(upstreamConfig, '/root', filename, data, baseTransformOptions);

      expect(upstreamCalls()).toHaveLength(1);
      const [call] = upstreamCalls();
      expect(call.config).toBe(upstreamConfig);
      expect(call.projectRoot).toBe('/root');
      expect(call.filename).toBe(filename);
      expect(call.data).toBe(data);
      expect(call.options).toBe(baseTransformOptions);
      // Extra fields (Expo's `css` metadata) must survive for its serializer.
      expect((result.output[0].data as { css?: { code: string } }).css?.code).toBe(
        ':root { --a: 1px; }',
      );
    },
  );

  test('keeps JS files on the SWC path', async () => {
    const result = await transform(
      upstreamConfig,
      '/root',
      'index.js',
      Buffer.from('export const a = 1;'),
      baseTransformOptions,
    );
    expect(upstreamCalls()).toHaveLength(0);
    expect(result.output[0].data.code).toContain('__d(');
  });

  test('throws a clear error for CSS without an upstream worker', async () => {
    await expect(
      transform(baseConfig, '/root', 'global.css', Buffer.from(':root {}'), baseTransformOptions),
    ).rejects.toThrow("can't transform CSS on its own");
  });
});

describe('getCacheKey — upstream transformer', () => {
  test("includes the upstream worker's cache key", () => {
    const withoutUpstream = getCacheKey(baseConfig);
    const a = getCacheKey({ ...upstreamConfig, upstreamCacheSalt: 'a' } as never);
    const b = getCacheKey({ ...upstreamConfig, upstreamCacheSalt: 'b' } as never);
    expect(a).toContain('upstream:a');
    expect(a).not.toEqual(withoutUpstream);
    expect(a).not.toEqual(b);
  });
});
