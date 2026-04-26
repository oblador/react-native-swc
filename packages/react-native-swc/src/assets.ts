/**
 * Asset transform. Delegates to Metro's own `getAssetData` to produce the
 * `registerAsset` call, then feeds the resulting JS back through
 * `transformJs` so the code gets the same module-wrap / minify / require-
 * rewrite passes any other module does.
 *
 * This module exists mostly to keep the "call a JSON Metro helper" in one
 * place so the main transform-worker entry can stay focused on
 * orchestration.
 */
import { resolve } from 'node:path';

import { transformJs } from './transform-js';
import type { JsTransformOptions, JsTransformerConfig, TransformResponse } from './types';

export async function transformAsset(
  filename: string,
  config: JsTransformerConfig,
  options: JsTransformOptions,
  projectRoot: string,
): Promise<TransformResponse> {
  // Metro's internal API; only pulled in when we actually transform an asset.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getAssetData } = require('metro/private/Assets') as {
    getAssetData: (
      absolute: string,
      relative: string,
      plugins: ReadonlyArray<string>,
      platform: string | null | undefined,
      publicPath: string,
    ) => Promise<Record<string, unknown>>;
  };

  const data = await getAssetData(
    resolve(projectRoot, filename),
    filename,
    config.assetPlugins,
    options.platform,
    config.publicPath,
  );

  // Drop server-side-only fields before serialising into the module body.
  // Mirrors the blocklist from `generateAssetCodeFileAst`.
  const { files: _f, fileSystemLocation: _l, path: _p, ...descriptor } = data;

  const assetCode =
    `module.exports = require(${JSON.stringify(config.assetRegistryPath)})` +
    `.registerAsset(${JSON.stringify(descriptor)});`;

  return transformJs({
    jsType: 'js/module/asset',
    filename,
    code: assetCode,
    inputMap: [],
    config,
    options,
    projectRoot,
    inputFileSize: Buffer.byteLength(assetCode),
  });
}
