import { minifySync, type JsMinifyOptions } from '@swc/core';
import type { Minifier } from 'metro-transform-worker';

// ---------------------------------------------------------------------------
// Minifier
// ---------------------------------------------------------------------------

const minifier: Minifier = function minifier(options) {
  const { code, map, filename, reserved, config } = options;

  const output =
    config.output != null && typeof config.output === 'object'
      ? (config.output as { comments?: boolean | 'all' | 'some' })
      : undefined;
  const swcComments =
    output?.comments === true
      ? 'all'
      : output?.comments === false || output?.comments === 'all' || output?.comments === 'some'
        ? output.comments
        : undefined;

  const swcOptions = {
    compress: (config.compress as JsMinifyOptions['compress']) ?? true,
    mangle:
      config.mangle === false
        ? false
        : {
            ...(config.mangle as object),
            reserved: reserved as string[],
          },
    sourceMap: !!map,
    module: (config.module as boolean) ?? false,
    format: swcComments != null ? { comments: swcComments } : undefined,
  } satisfies JsMinifyOptions;

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

export = minifier;
