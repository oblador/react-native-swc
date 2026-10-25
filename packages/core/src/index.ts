import type { MetroConfig } from 'metro-config';
import { captureExpoEnvironment } from './env';

import type { SwcTransformerOptions } from './transform-worker';
import { getUpstreamTransformerPath } from './upstream';

export type { SwcTransformerOptions } from './transform-worker';

// ---------------------------------------------------------------------------
// Metro config helper
// ---------------------------------------------------------------------------

function applySwcTransformer(config: MetroConfig, swcConfig?: SwcTransformerOptions): MetroConfig {
  const effectiveSwcConfig = captureExpoEnvironment(swcConfig);
  const ownTransformerPath = require.resolve('./transform-worker');
  // Keep the worker we're replacing (e.g. Expo's) so file types SWC can't
  // handle, such as CSS, can be routed back to it.
  const upstreamTransformerPath = getUpstreamTransformerPath(config, ownTransformerPath);
  return {
    ...config,
    transformerPath: ownTransformerPath,
    transformer: {
      ...config.transformer,
      minifierPath: require.resolve('./minifier'),
      minifierConfig: {
        ...config.transformer?.minifierConfig,
      },
      ...(effectiveSwcConfig ? { swcConfig: effectiveSwcConfig } : {}),
      ...(upstreamTransformerPath ? { swcUpstreamTransformerPath: upstreamTransformerPath } : {}),
    },
  };
}

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
export function withSwcTransformer<T extends MetroConfig | Promise<MetroConfig>>(
  config: T,
  swcConfig?: SwcTransformerOptions,
): T {
  if ('then' in config) {
    return config.then((resolvedConfig) => applySwcTransformer(resolvedConfig, swcConfig)) as T;
  }
  return applySwcTransformer(config, swcConfig) as T;
}
