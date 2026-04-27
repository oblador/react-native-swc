/**
 * Metro transform-worker entry.
 *
 * Babel is no longer on the hot path. The pipeline is:
 *
 *   1. Route by file type (asset / JSON / script / module).
 *   2. For JS/TS files: run SWC (`swc.ts`) — one pass for type stripping,
 *      JSX, ESM→CJS, Hermes down-levelling, and the built-in metro-post
 *      WASM plugin (optional experimental-import rewrite / inline /
 *      inline-requires / constant-folding / pseudo-global normalisation).
 *   3. Walk SWC's output in JS to rewrite `require("x")` calls to
 *      `_dependencyMap[N]` and collect the dependency list
 *      (`dependencies.ts`). This is the only JS-side re-parse and the
 *      largest outstanding perf item — see that file for the plan to
 *      move it into Rust.
 *   4. Wrap, minify, terminate the source map, return.
 *
 * Everything that needs a regex or a string splice because SWC / Metro
 * shapes don't quite line up lives under `hacks/` with a deletion note.
 */
import { generateCodegenSource, isCodegenFile } from './codegen';
import { runSwc } from './swc';
import { transformAsset } from './assets';
import { transformJs } from './transform-js';
import { transformJson } from './json';
import type {
  JsTransformOptions,
  JsTransformerConfig,
  JSFileType,
  TransformResponse,
} from './types';
import { METRO_MODULE_ID } from './wrap';

// ---------------------------------------------------------------------------
// Re-exports for tests and tooling
// ---------------------------------------------------------------------------

export { collectRequireRefs, transformRequires } from './dependencies';
export type {
  JsTransformerConfig,
  JsTransformOptions,
  SwcTransformerOptions,
  TransformResponse,
} from './types';

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export const transform = async (
  config: JsTransformerConfig,
  projectRoot: string,
  filename: string,
  data: Buffer,
  options: JsTransformOptions,
): Promise<TransformResponse> => {
  const sourceCode = data.toString('utf8');

  validateReservedStrings(sourceCode, config, options);

  if (filename.endsWith('.json')) {
    return transformJson(filename, sourceCode, config, options);
  }

  if (options.type === 'asset') {
    return transformAsset(filename, config, options, projectRoot);
  }

  const origSrc = isCodegenFile(sourceCode)
    ? generateCodegenSource(filename, sourceCode)
    : sourceCode;

  const { code, map } = runSwc(origSrc, filename, options, config.swcConfig);

  const jsType: JSFileType = options.type === 'script' ? 'js/script' : 'js/module';

  return transformJs({
    jsType,
    filename,
    code,
    inputMap: map,
    config,
    options,
    projectRoot,
    inputFileSize: data.byteLength,
  });
};

// ---------------------------------------------------------------------------
// getCacheKey
// ---------------------------------------------------------------------------

export const getCacheKey = (
  config: JsTransformerConfig,
  _opts?: Readonly<{ projectRoot: string }>,
): string => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const swcPkg = require('@swc/core/package.json') as { version: string };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getCacheKey: metroGetCacheKey } = require('metro-cache-key') as {
    getCacheKey: (paths: string[]) => string;
  };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHash } = require('node:crypto') as typeof import('node:crypto');

  const userConfigKey = config.swcConfig
    ? createHash('sha1').update(JSON.stringify(config.swcConfig)).digest('hex')
    : '';
  return [metroGetCacheKey([__filename]), `swc@${swcPkg.version}`, userConfigKey].join('$');
};

export default { transform, getCacheKey };

// ---------------------------------------------------------------------------
// Small local helpers
// ---------------------------------------------------------------------------

function validateReservedStrings(
  sourceCode: string,
  config: JsTransformerConfig,
  options: JsTransformOptions,
): void {
  // Fast path: most builds set neither flag. Skip allocating the temporary
  // array and the (cheap but non-zero) per-string indexOf scan in that case.
  const hasModuleId = options.customTransformOptions?.unstable_staticHermesOptimizedRequire;
  const depMapName = config.unstable_dependencyMapReservedName;
  if (!hasModuleId && depMapName == null) return;

  if (hasModuleId) {
    const pos = sourceCode.indexOf(METRO_MODULE_ID);
    if (pos > -1) {
      throw new SyntaxError(
        `Source code contains the reserved string \`${METRO_MODULE_ID}\` at character offset ${pos}`,
      );
    }
  }
  if (depMapName != null) {
    const pos = sourceCode.indexOf(depMapName);
    if (pos > -1) {
      throw new SyntaxError(
        `Source code contains the reserved string \`${depMapName}\` at character offset ${pos}`,
      );
    }
  }
}
