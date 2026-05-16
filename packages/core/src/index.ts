import type { MetroConfig } from "metro-config";

import type { SwcTransformerOptions } from "./transform-worker";

export type { SwcTransformerOptions } from "./transform-worker";

// ---------------------------------------------------------------------------
// Metro config helper
// ---------------------------------------------------------------------------

/**
 * Wrap a Metro configuration object so that SWC is used for transpilation
 * and minification.
 *
 * Uses Metro's `transformerPath` to override the entire transform worker,
 * eliminating Babel from the hot path entirely.
 *
 * The optional second argument exposes a narrow surface for customizing the
 * SWC pipeline — currently `plugins` (prepended to the built-in metro-post
 * plugin) and `env` (replaces the default env if set). Everything else is
 * owned by the transform worker. The config is shipped to workers via a
 * custom `transformer.swcConfig` key.
 *
 * @example
 * ```js
 * // metro.config.js
 * const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');
 * const { withSwcTransformer } = require('@react-native-swc/core');
 *
 * module.exports = withSwcTransformer(
 *   mergeConfig(getDefaultConfig(__dirname), {}),
 *   { plugins: [['@react-native-swc/worklets-plugin', {}]] },
 * );
 * ```
 */
export function withSwcTransformer(
  config: MetroConfig | Promise<MetroConfig>,
  swcConfig?: SwcTransformerOptions,
): () => Promise<MetroConfig> {
  return async function () {
    const resolvedConfig = await config;
    return {
      ...resolvedConfig,
      transformerPath: require.resolve("./transform-worker"),
      transformer: {
        ...resolvedConfig.transformer,
        minifierPath: require.resolve("./minifier"),
        minifierConfig: {
          ...resolvedConfig.transformer?.minifierConfig,
        },
        ...(swcConfig ? { swcConfig } : {}),
      },
    };
  };
}
