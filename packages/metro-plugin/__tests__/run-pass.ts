/**
 * Test runner for a single metro-post plugin pass.
 *
 * Exercises the same WASM plugin Metro loads in production: every pass is
 * individually toggleable via options, so tests set exactly one flag and
 * drive the plugin via `@swc/core`'s `transformSync`. No NAPI, no separate
 * per-pass entry point.
 */
import { resolve } from 'node:path';
import { transformSync } from '@swc/core';

const PLUGIN_PATH = resolve(__dirname, '..', 'metro_plugin.wasm');

export interface InlineOptions {
  inlinePlatform?: boolean;
  platform?: string;
  isWrapped?: boolean;
  /** When set, replace `__DEV__` with this boolean literal in the inline pass. */
  dev?: boolean;
  /** When set, replace `process.env.NODE_ENV` with this string literal in the inline pass. */
  nodeEnv?: string;
}

export interface InlineRequiresOptions {
  nonInlinedRequires?: string[];
  extraInlineableCalls?: string[];
  memoizeCalls?: boolean;
  nonMemoizedModules?: string[];
}

type PassOpts =
  | { pass: 'experimentalImports' }
  | ({ pass: 'inline' } & InlineOptions)
  | ({ pass: 'inlineRequires' } & InlineRequiresOptions)
  | { pass: 'constantFolding' }
  | ({ pass: 'inlineThenFold' } & InlineOptions);

function pluginOptions(opts: PassOpts): Record<string, unknown> {
  switch (opts.pass) {
    case 'experimentalImports':
      return { experimentalImports: true };
    case 'inline': {
      const base: Record<string, unknown> = {
        inline: true,
        inlinePlatform: opts.inlinePlatform ?? false,
        platform: opts.platform ?? '',
        isWrapped: opts.isWrapped ?? false,
      };
      if (opts.dev !== undefined) base.dev = opts.dev;
      if (opts.nodeEnv !== undefined) base.nodeEnv = opts.nodeEnv;
      return base;
    }
    case 'inlineRequires':
      return {
        inlineRequires: true,
        nonInlinedRequires: opts.nonInlinedRequires ?? [],
        extraInlineableCalls: opts.extraInlineableCalls ?? [],
        memoizeCalls: opts.memoizeCalls ?? false,
        nonMemoizedModules: opts.nonMemoizedModules ?? [],
      };
    case 'constantFolding':
      return { constantFolding: true };
    case 'inlineThenFold': {
      const base: Record<string, unknown> = {
        inline: true,
        constantFolding: true,
        inlinePlatform: opts.inlinePlatform ?? false,
        platform: opts.platform ?? '',
        isWrapped: opts.isWrapped ?? false,
      };
      if (opts.dev !== undefined) base.dev = opts.dev;
      if (opts.nodeEnv !== undefined) base.nodeEnv = opts.nodeEnv;
      return base;
    }
  }
}

/** Parse + re-emit `code` through SWC with no plugin. Used to normalize the
 *  "expected" side of a comparison so assertions match canonical formatting. */
export function format(code: string): string {
  return transformSync(code, {
    swcrc: false,
    configFile: false,
    jsc: { parser: { syntax: 'ecmascript' }, target: 'es2022' },
    isModule: true,
  }).code;
}

/** Run the metro-post plugin with exactly one pass enabled. */
export function runPass(code: string, opts: PassOpts): string {
  const result = transformSync(code, {
    swcrc: false,
    configFile: false,
    jsc: {
      parser: { syntax: 'ecmascript' },
      target: 'es2022',
      experimental: {
        plugins: [[PLUGIN_PATH, pluginOptions(opts)]],
      },
    },
    isModule: true,
  });
  return result.code;
}
