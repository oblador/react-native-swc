/**
 * Delegation to the Metro transform worker that `withSwcTransformer`
 * replaced (e.g. Expo's), for file types SWC can't handle such as CSS.
 */
import type { MetroConfig } from 'metro-config';

import type { JsTransformOptions, JsTransformerConfig, TransformResponse } from './types';

// Metro's own default `transformerPath`. It has nothing the SWC worker
// would want to delegate to, so it isn't recorded as an upstream.
const METRO_DEFAULT_TRANSFORMER_PATH = 'metro-transform-worker';

export interface UpstreamTransformer {
  transform: (
    config: JsTransformerConfig,
    projectRoot: string,
    filename: string,
    data: Buffer,
    options: JsTransformOptions,
  ) => Promise<TransformResponse>;
  getCacheKey?: (config: JsTransformerConfig, opts?: Readonly<{ projectRoot: string }>) => string;
}

/**
 * Pick the worker to record as upstream when `config` is wrapped. When the
 * config has already been wrapped, the previously recorded upstream is
 * carried forward instead of pointing the worker at itself.
 */
export function getUpstreamTransformerPath(
  config: MetroConfig,
  ownTransformerPath: string,
): string | undefined {
  if (config.transformerPath === ownTransformerPath) {
    return (config.transformer as { swcUpstreamTransformerPath?: string } | undefined)
      ?.swcUpstreamTransformerPath;
  }
  if (config.transformerPath === METRO_DEFAULT_TRANSFORMER_PATH) return undefined;
  return config.transformerPath;
}

export function loadUpstreamTransformer(transformerPath: string): UpstreamTransformer {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(transformerPath) as UpstreamTransformer;
}
