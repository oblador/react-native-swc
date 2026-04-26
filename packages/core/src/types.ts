/**
 * Types shared across the worker modules. Mostly a minimal mirror of the
 * Metro transform-worker ABI so we can stay off the `metro-transform-worker`
 * type surface — we *replace* that worker rather than extend it.
 */
import type { ParserConfig } from '@swc/core';

export type DynamicRequiresBehavior = 'throwAtRuntime' | 'reject';
export type AllowOptionalDependencies = boolean | { readonly exclude: ReadonlyArray<string> };
export type ContextMode = 'sync' | 'eager' | 'lazy' | 'lazy-once';
export type TransformProfile = 'default' | 'hermes-stable' | 'hermes-canary';
export type Type = 'script' | 'module' | 'asset';
export type JSFileType = 'js/script' | 'js/module' | 'js/module/asset';
export type AsyncType = null | 'async' | 'prefetching' | 'weak';

export interface MinifierConfig {
  readonly [key: string]: unknown;
}

export type MetroGeneratedCodeMapping = [number, number];
export type MetroSourceMapping = [number, number, number, number];
export type MetroSourceMappingWithName = [number, number, number, number, string];
export type MetroSourceMapSegmentTuple =
  | MetroGeneratedCodeMapping
  | MetroSourceMapping
  | MetroSourceMappingWithName;

/**
 * Narrow opt-in surface exposed by `withSwcTransformer`. Only these two
 * fields are user-controllable — everything else (parser, module, isModule,
 * assumptions, env …) is controlled by the worker because Metro correctness
 * depends on it.
 *
 * - `plugins`: user SWC plugins; prepended to the built-in metro-post
 *   plugin so user transforms run first.
 * - `envs`: `process.env.FOO` replacements inlined at build time. Values
 *   are JSON-encoded for you, so `{ API_URL: "https://x" }` replaces
 *   `process.env.API_URL` with the literal string `"https://x"`.
 */
export interface SwcTransformerOptions {
  plugins?: ReadonlyArray<[string, Record<string, unknown>]>;
  envs?: Record<string, string>;
}

export interface JsTransformerConfig {
  readonly assetPlugins: ReadonlyArray<string>;
  readonly assetRegistryPath: string;
  readonly asyncRequireModulePath: string;
  readonly babelTransformerPath: string;
  readonly dynamicDepsInPackages: DynamicRequiresBehavior;
  readonly enableBabelRCLookup: boolean;
  readonly enableBabelRuntime: boolean | string;
  readonly globalPrefix: string;
  readonly hermesParser: boolean;
  readonly minifierConfig: MinifierConfig;
  readonly minifierPath: string;
  /** @deprecated No longer consulted — SWC's minifier mangles factory params directly. Kept for Metro config ABI compatibility. */
  readonly optimizationSizeLimit: number;
  readonly publicPath: string;
  readonly allowOptionalDependencies: AllowOptionalDependencies;
  readonly unstable_dependencyMapReservedName: string | null | undefined;
  readonly unstable_disableModuleWrapping: boolean;
  /** @deprecated No longer consulted — the normalize pass was removed. Kept for Metro config ABI compatibility. */
  readonly unstable_disableNormalizePseudoGlobals: boolean;
  readonly unstable_allowRequireContext: boolean;
  readonly unstable_memoizeInlineRequires?: boolean;
  readonly unstable_nonMemoizedInlineRequires?: ReadonlyArray<string>;
  readonly unstable_renameRequire?: boolean;
  /**
   * Opt-in SWC customizations exposed by `withSwcTransformer` and forwarded
   * by Metro via a custom `transformer.swcConfig` key.
   */
  readonly swcConfig?: SwcTransformerOptions;
}

export interface CustomTransformOptions {
  [key: string]: unknown;
}

export interface JsTransformOptions {
  readonly customTransformOptions?: CustomTransformOptions;
  readonly dev: boolean;
  readonly experimentalImportSupport?: boolean;
  readonly inlinePlatform: boolean;
  readonly inlineRequires: boolean;
  readonly minify: boolean;
  readonly nonInlinedRequires?: ReadonlyArray<string>;
  readonly platform: string | null | undefined;
  readonly type: Type;
  readonly unstable_memoizeInlineRequires?: boolean;
  readonly unstable_nonMemoizedInlineRequires?: ReadonlyArray<string>;
  readonly unstable_staticHermesOptimizedRequire?: boolean;
  readonly unstable_transformProfile: TransformProfile;
}

export interface JsOutput {
  readonly data: {
    readonly code: string;
    readonly lineCount: number;
    readonly map: Array<MetroSourceMapSegmentTuple>;
    readonly functionMap: null;
  };
  readonly type: JSFileType;
}

export interface TransformResponse {
  readonly dependencies: ReadonlyArray<TransformResultDependency>;
  readonly output: ReadonlyArray<JsOutput>;
}

export interface TransformResultDependency {
  readonly name: string;
  readonly data: {
    readonly key: string;
    readonly asyncType: AsyncType;
    readonly isESMImport?: boolean;
    readonly isOptional: boolean;
    readonly contextParams?: {
      readonly recursive: boolean;
      readonly filter: {
        readonly pattern: string;
        readonly flags: string;
      };
      readonly mode: ContextMode;
    };
    readonly locs: ReadonlyArray<unknown>;
    readonly exportNames: ReadonlyArray<string>;
  };
}

// ---------------------------------------------------------------------------
// SWC parser extensions
// ---------------------------------------------------------------------------

/**
 * SWC supports Flow parsing but the published `@swc/core` types don't include
 * it. This mirrors the runtime surface.
 */
export interface FlowParserConfig {
  syntax: 'flow';
  jsx?: boolean;
  all?: boolean;
  requireDirective?: boolean;
  enums?: boolean;
  decorators?: boolean;
  components?: boolean;
  patternMatching?: boolean;
}

export type ExtendedParserConfig = ParserConfig | FlowParserConfig;
