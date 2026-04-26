/**
 * Module-path core. Takes the SWC-transformed body of a JS file and
 * produces the final Metro-wrapped, optionally-minified output along with
 * the resolved dependency list.
 *
 * Kept separate from `transform-worker.ts` so the top-level entry can stay
 * focused on dispatch (JSON / asset / script / module) while this file
 * owns the module pipeline (dynamic-require handling → static require
 * rewrite → module wrap → minify).
 */
import { dirname, join, relative } from 'node:path';

import {
  collectRequireRefs,
  handleDynamicRequires,
  transformRequires,
  type RequireRef,
} from './dependencies';
import { minifyCode, shouldMinify } from './minify';
import { countLinesAndTerminateMap, countNewlines, shiftGeneratedLines } from './source-map';
import type {
  JSFileType,
  JsTransformOptions,
  JsTransformerConfig,
  MetroSourceMapSegmentTuple,
  TransformResponse,
} from './types';
import { DEP_MAP_NAME, wrapModule, wrapPolyfill } from './wrap';

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export interface TransformJsContext {
  jsType: JSFileType;
  filename: string;
  code: string;
  inputMap: ReadonlyArray<MetroSourceMapSegmentTuple>;
  config: JsTransformerConfig;
  options: JsTransformOptions;
  projectRoot: string;
  inputFileSize: number;
}

export async function transformJs(ctx: TransformJsContext): Promise<TransformResponse> {
  if (ctx.jsType === 'js/script') return transformScript(ctx);
  return transformModule(ctx);
}

// ---------------------------------------------------------------------------
// Script path — polyfills / runtime-injected scripts
// ---------------------------------------------------------------------------

async function transformScript(ctx: TransformJsContext): Promise<TransformResponse> {
  let code = wrapPolyfill(ctx.code);
  let map = shiftGeneratedLines(ctx.inputMap, countNewlines('(function(global) {\n'));

  if (shouldMinify(ctx.options)) {
    ({ code, map } = minifyCode(code, [], map));
  }

  const { lineCount, map: finalMap } = countLinesAndTerminateMap(code, map);
  return {
    dependencies: [],
    output: [
      {
        data: { code, functionMap: null, lineCount, map: finalMap },
        type: ctx.jsType,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Module path
// ---------------------------------------------------------------------------

async function transformModule(ctx: TransformJsContext): Promise<TransformResponse> {
  const contextEnvValues = buildContextEnvValues(ctx);

  let src = ctx.code;

  // A single AST walk covers both static + dynamic refs.
  const collectOpts = {
    allowRequireContext: ctx.config.unstable_allowRequireContext,
    envValues: contextEnvValues,
  };
  const refs = collectRequireRefs(src, collectOpts);
  const hasDynamic = refs.some((r) => r.isDynamic);
  src = handleDynamicRequires(src, ctx.filename, effectiveDynamicBehavior(ctx), refs);

  // When there were no dynamic requires, `handleDynamicRequires` returns
  // `src` byte-identical, so the static refs we already collected are still
  // valid and we can skip an entire SWC parse. With dynamic requires,
  // `handleDynamicRequires` splices into `src` and offsets shift — re-parse.
  const staticRefs = hasDynamic ? undefined : refs.filter((r) => !r.isDynamic);
  const { code: bodyWithDeps, dependencies } = transformRequires(src, collectOpts, staticRefs);

  const bodyFinal = renameDepMap(bodyWithDeps, ctx.config.unstable_dependencyMapReservedName);

  const { code: wrapped, map } = wrapWithSourceMap(bodyFinal, ctx.config, ctx.inputMap);

  const { code, map: finalMap } = maybeMinify(wrapped, map, ctx);

  const { lineCount, map: terminatedMap } = countLinesAndTerminateMap(code, finalMap);

  return {
    dependencies,
    output: [
      {
        data: { code, functionMap: null, lineCount, map: terminatedMap },
        type: ctx.jsType,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Step helpers
// ---------------------------------------------------------------------------

function buildContextEnvValues(ctx: TransformJsContext): Record<string, string> {
  const out: Record<string, string> = {};
  if (!ctx.projectRoot) return out;
  const customOpts = ctx.options.customTransformOptions;
  const routerRoot =
    typeof customOpts?.routerRoot === 'string' ? decodeURI(customOpts.routerRoot) : 'app';
  const asyncRoutes = customOpts?.asyncRoutes === 'true' || customOpts?.asyncRoutes === true;
  const absAppRoot = join(ctx.projectRoot, routerRoot);
  out.EXPO_ROUTER_APP_ROOT = relative(dirname(ctx.filename), absAppRoot);
  out.EXPO_ROUTER_IMPORT_MODE = asyncRoutes ? 'lazy' : 'sync';
  return out;
}

function effectiveDynamicBehavior(ctx: TransformJsContext): 'reject' | 'throwAtRuntime' {
  const inNodeModules =
    ctx.filename.includes('/node_modules/') ||
    ctx.filename.startsWith('node_modules/') ||
    ctx.filename.startsWith('node_modules\\');
  return inNodeModules && ctx.config.dynamicDepsInPackages === 'throwAtRuntime'
    ? 'throwAtRuntime'
    : 'reject';
}

function renameDepMap(body: string, depMapName: string | null | undefined): string {
  if (!depMapName) return body;
  // Node 18+: `replaceAll` is faster than split+join (single pass over the
  // string, no intermediate array of pieces).
  return body.replaceAll(DEP_MAP_NAME, depMapName);
}

function wrapWithSourceMap(
  body: string,
  config: JsTransformerConfig,
  inputMap: ReadonlyArray<MetroSourceMapSegmentTuple>,
): { code: string; map: ReadonlyArray<MetroSourceMapSegmentTuple> } {
  if (config.unstable_disableModuleWrapping) {
    // No wrap, no shift. Hand the input array straight through —
    // `countLinesAndTerminateMap` makes its own copy before mutating.
    return { code: body, map: inputMap };
  }
  const depMapName = config.unstable_dependencyMapReservedName ?? undefined;
  const code = wrapModule(
    body,
    config.globalPrefix,
    config.unstable_disableModuleWrapping,
    depMapName,
  );
  // The wrapper template's prefix has exactly one newline (the one before
  // `body`). `globalPrefix` is conventionally a runtime tag with no newlines;
  // count it explicitly only if it ever contains one.
  const globalPrefixLines = config.globalPrefix ? countNewlines(config.globalPrefix) : 0;
  const map = shiftGeneratedLines(inputMap, 1 + globalPrefixLines);
  return { code, map };
}

function maybeMinify(
  codeIn: string,
  mapIn: ReadonlyArray<MetroSourceMapSegmentTuple>,
  ctx: TransformJsContext,
): { code: string; map: ReadonlyArray<MetroSourceMapSegmentTuple> } {
  if (!shouldMinify(ctx.options)) {
    // Pass-through. The downstream `countLinesAndTerminateMap` already copies.
    return { code: codeIn, map: mapIn };
  }

  const depMapName = ctx.config.unstable_dependencyMapReservedName ?? undefined;

  // SWC's minifier mangles factory parameters itself. Pass through the
  // reserved dep-map name (when configured) so downstream tooling that
  // pattern-matches on the literal string still works.
  const reserved: string[] = depMapName ? [depMapName] : [];

  const minified = minifyCode(codeIn, reserved, mapIn, ctx.config);
  return { code: minified.code, map: minified.map };
}

// ---------------------------------------------------------------------------
// Helpers for external callers
// ---------------------------------------------------------------------------

export type { RequireRef };
