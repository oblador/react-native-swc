/**
 * Minifier wrapper. `minifier.ts` (in the same package) is the public Metro
 * minifier entry; this module is the internal helper used from inside the
 * transform worker so minify + source-map composition stays in one place.
 */
import { minifySync, type JsMinifyOptions } from '@swc/core';
import type { Minifier } from 'metro-transform-worker';

import { composeSourceMaps, decodeRawSourceMap } from './source-map';
import type { JsTransformerConfig, JsTransformOptions, MetroSourceMapSegmentTuple } from './types';

export function shouldMinify(options: JsTransformOptions): boolean {
  return (
    options.minify &&
    options.unstable_transformProfile !== 'hermes-canary' &&
    options.unstable_transformProfile !== 'hermes-stable'
  );
}

// ---------------------------------------------------------------------------
// Terser → SWC config translation
// ---------------------------------------------------------------------------
//
// Metro's `transformer.minifierConfig` is shaped to drive
// `metro-minify-terser`. SWC's `JsMinifyOptions` is a near-mirror of
// Terser's API by design — `compress`, `mangle`, `sourceMap`, `toplevel`,
// `ecma`, `keep_classnames`, `keep_fnames`, etc. share their names and
// shapes — so most of the user's config can be forwarded unchanged.
//
// The two adjustments needed:
//
//   1. Terser's `output` → SWC's `format`. SWC accepts both camelCase
//      (`asciiOnly`) and snake_case (`ascii_only`) keys inside `format`
//      via `ToSnakeCaseProperties`, so we copy the user's keys verbatim
//      and let SWC consume whichever spelling they used.
//
//   2. `mangle.reserved` is *augmented* (not replaced) with the names the
//      caller pinned for the worker — typically the dependency-map factory
//      param. Reserved names must NOT be mangled because downstream tooling
//      pattern-matches on the literal symbol.
//
// We deliberately do NOT supply our own defaults. If the user passes no
// `minifierConfig`, SWC's own defaults (full `compress`, full `mangle`)
// apply. This matches how Metro itself behaves: its defaults live in the
// caller's `metro-config`, not inside the minifier.

type TerserStyleConfig = {
  compress?: boolean | Record<string, unknown>;
  mangle?: boolean | Record<string, unknown>;
  // Terser's name for the codegen options block; SWC calls it `format`.
  output?: Record<string, unknown>;
  format?: Record<string, unknown>;
  // Top-level passthroughs that share their name with SWC.
  toplevel?: boolean;
  ecma?: number | string;
  keep_classnames?: boolean;
  keep_fnames?: boolean;
  module?: boolean | 'unknown';
  safari10?: boolean;
  // `sourceMap` is consumed by the wrapper, not forwarded — we always
  // request a sourceMap from SWC and compose it with the inputMap.
};

function readMinifierConfig(config: JsTransformerConfig | undefined): TerserStyleConfig {
  if (!config?.minifierConfig || typeof config.minifierConfig !== 'object') return {};
  return config.minifierConfig as TerserStyleConfig;
}

function namePreservationOptions(cfg: TerserStyleConfig): Record<string, boolean> {
  const options: Record<string, boolean> = {};
  if (cfg.keep_classnames != null) options.keep_classnames = cfg.keep_classnames;
  if (cfg.keep_fnames != null) options.keep_fnames = cfg.keep_fnames;
  return options;
}

function compressOption(cfg: TerserStyleConfig): JsMinifyOptions['compress'] {
  if (cfg.compress === false) return false;
  const names = namePreservationOptions(cfg);
  if (cfg.compress != null && typeof cfg.compress === 'object') {
    return { ...names, ...cfg.compress } as JsMinifyOptions['compress'];
  }
  return Object.keys(names).length > 0 ? names : true;
}

function mangleOption(
  cfg: TerserStyleConfig,
  reserved: ReadonlyArray<string>,
): JsMinifyOptions['mangle'] {
  if (cfg.mangle === false) return false;
  const user =
    cfg.mangle != null && typeof cfg.mangle === 'object'
      ? (cfg.mangle as Record<string, unknown>)
      : undefined;
  const names = namePreservationOptions(cfg);
  if (!user && reserved.length === 0 && Object.keys(names).length === 0) return true;
  const userReserved = (user?.reserved as ReadonlyArray<string> | undefined) ?? [];
  return {
    ...names,
    ...user,
    reserved: [...userReserved, ...reserved],
  } as JsMinifyOptions['mangle'];
}

function formatOption(cfg: TerserStyleConfig): JsMinifyOptions['format'] {
  // Terser's `output` block maps to SWC's `format`. SWC accepts both
  // camelCase and snake_case keys inside format (via `ToSnakeCaseProperties`),
  // so passing terser-style keys verbatim works.
  if (cfg.output == null && cfg.format == null) return undefined;
  return { ...cfg.output, ...cfg.format } as JsMinifyOptions['format'];
}

function buildMinifyOptions(
  cfg: TerserStyleConfig,
  reserved: ReadonlyArray<string>,
  sourceMap = true,
): JsMinifyOptions {
  const opts: JsMinifyOptions = {
    compress: compressOption(cfg),
    mangle: mangleOption(cfg, reserved),
    sourceMap,
  };
  const format = formatOption(cfg);
  if (format != null) opts.format = format;
  // Top-level terser options whose names match SWC's verbatim. Forward
  // when present so users get the same effect they'd get under terser.
  if (cfg.toplevel != null) opts.toplevel = cfg.toplevel;
  if (cfg.ecma != null) opts.ecma = cfg.ecma as JsMinifyOptions['ecma'];
  if (cfg.keep_classnames != null) opts.keep_classnames = cfg.keep_classnames;
  if (cfg.keep_fnames != null) opts.keep_fnames = cfg.keep_fnames;
  if (cfg.module != null) opts.module = cfg.module;
  if (cfg.safari10 != null) opts.safari10 = cfg.safari10;
  return opts;
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
  const cfg = readMinifierConfig(config);
  const result = minifySync(code, buildMinifyOptions(cfg, reserved));
  const minifiedMap = decodeRawSourceMap(result.map);
  return {
    code: result.code,
    map: composeSourceMaps(minifiedMap, inputMap),
  };
}

export const metroMinifier: Minifier = function metroMinifier(options) {
  const { code, map, filename, reserved, config } = options;

  const swcOptions = buildMinifyOptions(config, reserved, !!map);

  const result = minifySync(code, swcOptions);

  if (!map || result.map == null) {
    return { code: result.code };
  }

  return {
    code: result.code,
    map: {
      ...JSON.parse(result.map),
      sources: [filename],
    },
  };
};
