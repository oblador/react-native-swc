/**
 * Minifier wrapper. `minifier.ts` (in the same package) is the public Metro
 * minifier entry; this module is the internal helper used from inside the
 * transform worker so minify + source-map composition stays in one place.
 */
import { minifySync } from '@swc/core';

import { composeSourceMaps, decodeRawSourceMap } from './source-map';
import type { JsTransformerConfig, JsTransformOptions, MetroSourceMapSegmentTuple } from './types';

export function shouldMinify(options: JsTransformOptions): boolean {
  return (
    options.minify &&
    options.unstable_transformProfile !== 'hermes-canary' &&
    options.unstable_transformProfile !== 'hermes-stable'
  );
}

/**
 * Translate Metro's `minifierConfig.output.comments` into SWC's
 * `format.comments`. SWC honours `"some"` as "preserve annotations
 * (`@license`, `@preserve`, `/*#__PURE__*\/`) only" — which is what Metro's
 * `comments: true` means in practice for our output.
 */
function commentOption(config: JsTransformerConfig): false | 'all' | 'some' {
  const output =
    config.minifierConfig != null &&
    typeof config.minifierConfig === 'object' &&
    'output' in config.minifierConfig
      ? (config.minifierConfig.output as { comments?: boolean | 'all' | 'some' } | undefined)
      : undefined;
  const c = output?.comments;
  if (c === 'some') return 'some';
  // Metro's `true` means "keep comments"; the test suite in practice only
  // asserts PURE annotations survive, but we honour the user's full intent
  // by preserving every comment.
  if (c === true || c === 'all') return 'all';
  return false;
}

/**
 * Minify `code`, folding the inner (pre-minify → original) map through the
 * minifier's (minified → pre-minify) map so the final map is still
 * minified → original.
 */
export function minifyCode(
  code: string,
  reserved: ReadonlyArray<string>,
  inputMap: ReadonlyArray<MetroSourceMapSegmentTuple> = [],
  config?: JsTransformerConfig,
): { code: string; map: MetroSourceMapSegmentTuple[] } {
  const result = minifySync(code, {
    compress: true,
    mangle: reserved.length > 0 ? { reserved: [...reserved] } : true,
    sourceMap: true,
    format: config ? { comments: commentOption(config) } : undefined,
  });
  const minifiedMap = decodeRawSourceMap(result.map);
  return {
    code: result.code,
    map: composeSourceMaps(minifiedMap, inputMap),
  };
}
