/**
 * Test runner for the worklets SWC plugin.
 *
 * Invokes the plugin the same way Metro does in production: via
 * `@swc/core`'s `transformSync` with the compiled WASM plugin loaded
 * through SWC's plugin mechanism. No NAPI addon is involved.
 *
 * Release-mode detection: the plugin reads SWC's plugin-env metadata,
 * which is populated by SWC from the top-level `envName` option.
 * Passing `envName` explicitly here (rather than relying on
 * `process.env.NODE_ENV`) side-steps Jest's VM-scoped `process.env`
 * proxy that doesn't propagate to the native SWC side. The plugin then
 * matches the value against the `/(prod|release|stag[ei])/i` pattern
 * from Reanimated's upstream Babel plugin.
 */
import { resolve } from 'node:path';
import { transformSync } from '@swc/core';

export interface PluginOptions {
  bundleMode?: boolean;
  disableInlineStylesWarning?: boolean;
  disableSourceMaps?: boolean;
  disableWorkletClasses?: boolean;
  globals?: string[];
  relativeSourceLocation?: boolean;
  strictGlobal?: boolean;
  pluginVersion?: string;
}

const PLUGIN_PATH = resolve(__dirname, '..', 'worklets.wasm');

export function transform(code: string, filename: string, options?: PluginOptions | null): string {
  const result = transformSync(code, {
    filename,
    envName: process.env.NODE_ENV ?? 'development',
    swcrc: false,
    configFile: false,
    sourceMaps: false,
    jsc: {
      parser: { syntax: 'typescript', tsx: true, decorators: true },
      target: 'es2022',
      experimental: {
        plugins: [[PLUGIN_PATH, options ?? {}]],
      },
    },
    isModule: true,
  });
  return result.code;
}
