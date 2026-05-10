/**
 * SWC configuration and invocation.
 *
 * Everything that affects Metro correctness lives here — parser selection,
 * Hermes-safe down-leveling targets, CJS conversion rules, the built-in
 * metro-post plugin. The transform-worker calls exactly one function from
 * this module (`runSwc`) so the policy is easy to reason about.
 */
import {
  transformSync,
  type Options as SwcOptions,
  type ParserConfig,
  type ReactConfig,
} from '@swc/core';

import { decodeRawSourceMap } from './source-map';
import type {
  ExtendedParserConfig,
  JsTransformOptions,
  MetroSourceMapSegmentTuple,
  SwcTransformerOptions,
} from './types';
import { dirname, join, relative } from 'node:path';

// ---------------------------------------------------------------------------
// Parser selection
// ---------------------------------------------------------------------------

const tsParser: ParserConfig = { syntax: 'typescript', tsx: true };

const flowAllParser: ExtendedParserConfig = {
  syntax: 'flow',
  all: true,
  jsx: true,
  components: true,
  enums: true,
  patternMatching: true,
};

const flowDirectiveParser: ExtendedParserConfig = {
  syntax: 'flow',
  requireDirective: true,
  jsx: true,
  components: true,
  enums: true,
  patternMatching: true,
};

const ecmascriptParser: ParserConfig = { syntax: 'ecmascript', jsx: true };

const FLOW_PRAGMA_RE = /@(?:flow|noflow)\b/;

/**
 * Pick the SWC parser that best matches `filename` + `source`.
 *
 * - `.ts` / `.tsx`                      → TypeScript parser.
 * - React Native core `.js`             → Flow with `all: true` (RN source
 *                                         often lacks the `@flow` pragma).
 * - Other `.js` with `@flow`/`@noflow`  → Flow with `requireDirective: true`.
 * - Everything else                     → plain ECMAScript parser.
 *
 * The ECMAScript fallback is important: SWC's Flow parser activates
 * comment-type syntax (`/*: Type *\/`) even with `requireDirective`, which
 * makes it reject innocuous block comments like `/*:*\/` seen in real
 * packages (e.g. `markdown-it`'s character-class switch).
 *
 * `runSwc` retries with `flowAllParser` on any ECMAScript-parser failure to
 * cover third-party `.js` files that ship Flow syntax without an `@flow`
 * pragma (`react-native-blob-util`'s `fs.js` being the canonical case — its
 * `import type` line is commented out so a regex sniff misses it, but the
 * function bodies still carry `: Type` annotations).
 */
function selectParser(filename: string, source: string): ExtendedParserConfig {
  if (filename.endsWith('.ts') || filename.endsWith('.tsx')) return tsParser;
  if (filename.includes('/react-native/') || filename.includes('\\react-native\\')) {
    return flowAllParser;
  }
  if (FLOW_PRAGMA_RE.test(source)) return flowDirectiveParser;
  return ecmascriptParser;
}

// ---------------------------------------------------------------------------
// Environment / globals building blocks
// ---------------------------------------------------------------------------

/**
 * Build the `process.env.<KEY>` substitution map handed to the metro-plugin's
 * inline pass. Values are unescaped raw strings — the plugin emits each as
 * a `Lit::Str` directly, so `{ API_URL: "https://x" }` replaces
 * `process.env.API_URL` with the literal `"https://x"`.
 *
 * Lives next to (and intentionally fed alongside) the `dev` flag because
 * `__DEV__` and `process.env.NODE_ENV` are part of the same Metro contract:
 * both are inlined at compile time so downstream constant folding can
 * eliminate dead branches.
 */
function buildInlineEnvs(
  options: JsTransformOptions,
  filename: string,
  userConfig: SwcTransformerOptions | undefined,
): Record<string, string> {
  const { dev, platform, customTransformOptions } = options;
  const projectRoot = (options as unknown as { projectRoot?: string }).projectRoot;

  const envs: Record<string, string> = {
    NODE_ENV: dev ? 'development' : 'production',
    EXPO_OS: platform ?? '',
  };

  if (projectRoot) {
    envs.EXPO_PROJECT_ROOT = projectRoot;

    const routerRoot =
      typeof customTransformOptions?.routerRoot === 'string'
        ? decodeURI(customTransformOptions.routerRoot)
        : 'app';
    const asyncRoutes =
      customTransformOptions?.asyncRoutes === 'true' ||
      customTransformOptions?.asyncRoutes === true;
    const absAppRoot = join(projectRoot, routerRoot);

    envs.EXPO_ROUTER_APP_ROOT = relative(dirname(filename), absAppRoot);
    envs.EXPO_ROUTER_ABS_APP_ROOT = absAppRoot;
    envs.EXPO_ROUTER_IMPORT_MODE = asyncRoutes ? 'lazy' : 'sync';
  }

  if (userConfig?.envs) {
    for (const [k, v] of Object.entries(userConfig.envs)) {
      envs[k] = v;
    }
  }

  return envs;
}

// ---------------------------------------------------------------------------
// Hermes target
// ---------------------------------------------------------------------------

/**
 * Hermes supports most modern JS but has a few syntactic gaps a modern
 * baseline like `safari >= 16` would otherwise leave alone:
 *
 *   - class syntax (+ private methods/fields, public fields) — Hermes still
 *     uses the ES2017 class shape; our assumption `setPublicClassFields` &
 *     friends pair with the `transform-classes` include below.
 *   - `async` arrow functions and async generators.
 *   - `for (const x of …)` per-iteration binding semantics. Hermes reuses a
 *     single binding for the loop variable so closures over the loop
 *     variable all see the final value. `transform-block-scoping` rewrites
 *     the loop to preserve per-iteration identity.
 */
const HERMES_ENV_INCLUDE = [
  'transform-classes',
  'transform-private-methods',
  'transform-class-properties',
  'transform-private-property-in-object',
  'transform-async-to-generator',
  'transform-async-generator-functions',
  'transform-block-scoping',
] as const;

const HERMES_ENV: NonNullable<SwcOptions['env']> = {
  targets: 'safari >= 16',
  include: [...HERMES_ENV_INCLUDE],
};

// ---------------------------------------------------------------------------
// Built-in WASM plugin
// ---------------------------------------------------------------------------

let cachedMetroPluginPath: string | undefined;

/**
 * Resolve the path to the metro-post SWC plugin shipped alongside this
 * package. Cached because `require.resolve` walks node_modules; we only
 * ever need the answer once per worker.
 */
function resolveMetroPostPlugin(): string {
  if (cachedMetroPluginPath != null) return cachedMetroPluginPath;
  try {
    cachedMetroPluginPath = require.resolve('@react-native-swc/metro-plugin');
    return cachedMetroPluginPath;
  } catch (cause) {
    const err = new Error(
      'Failed to load required SWC wasm plugin `@react-native-swc/metro-plugin`. ' +
        'Ensure `@react-native-swc/metro-plugin` is installed and built with ' +
        '`pnpm --filter @react-native-swc/metro-plugin run build:wasm`.',
    ) as Error & { code?: string; cause?: unknown };
    err.code = 'METRO_POST_PLUGIN_LOAD_ERROR';
    err.cause = cause;
    throw err;
  }
}

/**
 * Config passed to the built-in metro-post WASM plugin. Field names match
 * `PostTransformPluginOptions` in
 * `packages/metro-plugin/crates/metro_plugin/src/wasm_plugin.rs`.
 *
 * Each pass is individually opt-in: production turns on
 * `experimentalImports` + `inline` + the conditional `inlineRequires` /
 * `constantFolding`. Tests flip one flag at a time to exercise a single
 * pass via the same entry point.
 */
interface PostTransformOptions {
  experimentalImports: boolean;
  inline: boolean;
  inlineRequires: boolean;
  constantFolding: boolean;
  inlinePlatform: boolean;
  platform: string;
  dev: boolean;
  envs: Record<string, string>;
  nonInlinedRequires: string[];
  extraInlineableCalls: string[];
}

/**
 * Compose user plugins (SWC WASM modules supplied via `withSwcTransformer`)
 * with the built-in metro-post plugin. The built-in plugin MUST run last so
 * earlier transforms can't re-introduce the syntax it normalises (inline
 * requires, constant folding, pseudo-global renaming).
 */
function buildPluginPipeline(
  postTransformOptions: PostTransformOptions,
  userConfig: SwcTransformerOptions | undefined,
): Array<[string, Record<string, unknown>]> {
  const builtin: [string, Record<string, unknown>] = [
    resolveMetroPostPlugin(),
    postTransformOptions as unknown as Record<string, unknown>,
  ];
  if (!userConfig?.plugins?.length) return [builtin];
  return [...(userConfig.plugins as Array<[string, Record<string, unknown>]>), builtin];
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Run SWC on `src` and return the transformed code along with its Metro-
 * formatted source map tuples. Everything stateful happens inside here:
 * parser choice, optimiser globals, Hermes env, plugin pipeline.
 */
export function runSwc(
  src: string,
  filename: string,
  options: JsTransformOptions,
  userConfig: SwcTransformerOptions | undefined,
): { code: string; map: MetroSourceMapSegmentTuple[] } {
  const { dev } = options;
  const envs = buildInlineEnvs(options, filename, userConfig);

  const reactConfig: ReactConfig = {
    runtime: 'automatic',
    development: dev,
    refresh: Boolean(dev),
  };

  const postTransformOptions: PostTransformOptions = {
    // Production always runs the ESM→CJS rewrite and the inline pass; the
    // other two are gated by upstream Metro options.
    experimentalImports: true,
    inline: true,
    inlineRequires: options.inlineRequires,
    // Match Metro's gate: constant folding only in production.
    constantFolding: !dev,
    inlinePlatform: options.inlinePlatform,
    platform: options.platform ?? '',
    dev,
    envs,
    nonInlinedRequires: [...(options.nonInlinedRequires ?? [])],
    // SWC already handles interop inline; no extra helper calls are needed.
    extraInlineableCalls: [],
  };

  const swcOptions: SwcOptions = {
    filename,
    // Surface NODE_ENV to SWC plugins via the plugin-env metadata, so e.g.
    // the worklets plugin can detect release mode with its upstream
    // `/(prod|release|stag[ei])/i` regex instead of a custom option.
    envName: dev ? 'development' : 'production',
    swcrc: false,
    configFile: false,
    sourceMaps: true,
    // Preserve `/*#__PURE__*/` and other annotation comments through all of
    // SWC's transforms. Matches Babel's behaviour and lets terser keep the
    // tree-shaking hints when minifying. The minifier is responsible for
    // stripping comments if `minifierConfig.output.comments === false`.
    // (Removing this flag forces us to re-inject annotations with a regex
    // hack; see `src/hacks/pure-annotations.ts` for the historical
    // workaround and `hacks/README.md` for the deletion criteria.)
    jsc: {
      parser: selectParser(filename, src) as ParserConfig,
      preserveAllComments: true,
      assumptions: {
        // Loose class transforms — match `@babel/preset-env {loose:true}`
        // behaviour (skip WeakMap / Object.defineProperty for classes)
        // which Hermes can execute without runtime support.
        privateFieldsAsProperties: true,
        setPublicClassFields: true,
      },
      experimental: {
        plugins: buildPluginPipeline(postTransformOptions, userConfig),
      },
      transform: {
        react: reactConfig,
      },
      externalHelpers: false,
    },
    env: HERMES_ENV,
    // Convert ESM → CJS so `require()` calls are visible to dependency
    // collection. Dynamic `import()` is left untouched for Metro's async
    // loading machinery. Under `experimentalImportSupport` the metro-plugin's
    // `experimentalImports` pass is the source of truth for the leading
    // `"use strict"` directive (it adds one for ESM, omits it for pure-CJS,
    // matching Babel's `importExportPlugin`); suppress SWC's unconditional
    // injection so we don't end up with a duplicate or an unwanted directive.
    module: {
      type: 'commonjs',
      ignoreDynamic: true,
      strictMode: !options.experimentalImportSupport,
    },
    // Modules are forced to module-mode. Scripts use `"unknown"` so that
    // Flow polyfills with `export type …` still parse; SWC's Flow parser
    // refuses any `export` token under `isModule: false`.
    isModule: options.type === 'script' ? 'unknown' : true,
  };

  let result;
  try {
    result = transformSync(src, swcOptions);
  } catch (e) {
    // Some third-party RN packages (notably react-native-blob-util) ship Flow
    // syntax in `.js` files without the `@flow` pragma. selectParser routed
    // them to the ECMAScript parser, which trips on `function f(x: T): U` etc.
    // Retry once with the Flow-all parser before giving up. Most projects hit
    // this on a small handful of files so the double-parse cost is bounded.
    if (swcOptions.jsc!.parser === ecmascriptParser) {
      swcOptions.jsc!.parser = flowAllParser as ParserConfig;
      result = transformSync(src, swcOptions);
    } else {
      throw e;
    }
  }
  return {
    code: result.code,
    map: decodeRawSourceMap(result.map),
  };
}
