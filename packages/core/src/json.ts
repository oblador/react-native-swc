/**
 * JSON file transform. Wraps the source as `module.exports = …` (or the
 * Hermes factory form), optionally minifies, and builds the Metro
 * `TransformResponse` the worker expects.
 */
import { countLinesAndTerminateMap } from './source-map';
import type {
  JsTransformOptions,
  JsTransformerConfig,
  JSFileType,
  MetroSourceMapSegmentTuple,
  TransformResponse,
} from './types';
import { wrapJson } from './wrap';
import { minifyCode, shouldMinify } from './minify';

export async function transformJson(
  _filename: string,
  code: string,
  config: JsTransformerConfig,
  options: JsTransformOptions,
): Promise<TransformResponse> {
  const useStaticHermes = Boolean(
    options.customTransformOptions?.unstable_staticHermesOptimizedRequire,
  );

  const jsType: JSFileType =
    options.type === 'asset'
      ? 'js/module/asset'
      : options.type === 'script'
        ? 'js/script'
        : 'js/module';

  let finalCode = wrapJson(
    code,
    config.globalPrefix,
    config.unstable_disableModuleWrapping,
    useStaticHermes,
  );
  let map: MetroSourceMapSegmentTuple[] = [];

  if (shouldMinify(options)) {
    ({ code: finalCode, map } = minifyCode(finalCode, []));
  }

  const { lineCount, map: finalMap } = countLinesAndTerminateMap(finalCode, map);

  return {
    dependencies: [],
    output: [
      {
        data: { code: finalCode, functionMap: null, lineCount, map: finalMap },
        type: jsType,
      },
    ],
  };
}
