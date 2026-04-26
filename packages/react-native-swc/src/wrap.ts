/**
 * Module-factory wrapping. Mirrors the strings Metro's `JsFileWrapping`
 * module would emit so consumers can't tell us apart; we stay on the string
 * side rather than ASTs because everything else in this pipeline is string-
 * based (SWC emits strings, the dependency rewrite is a byte-level splice).
 */

/** Name of the dependency-map factory param in emitted module code. */
export const DEP_MAP_NAME = '_dependencyMap';

/** Placeholder for the static-Hermes module id; stamped by the runtime. */
export const METRO_MODULE_ID = '_$$_METRO_MODULE_ID';

/**
 * Factory parameter list matching `JsFileWrapping.wrapModule` output.
 * `_$$_IMPORT_DEFAULT` / `_$$_IMPORT_ALL` are present for ABI compatibility
 * but SWC has already converted every ESM import to `require()`, so they
 * are never called in our output.
 */
const FACTORY_PARAMS = `global, require, _$$_IMPORT_DEFAULT, _$$_IMPORT_ALL, module, exports, ${DEP_MAP_NAME}`;

/**
 * Polyfill IIFE `global` resolver, identical to `JsFileWrapping.wrapPolyfill`.
 * Keeps environment detection in one place so polyfills work under Hermes,
 * Node, and browser-ish hosts alike.
 */
const GLOBAL_IIFE_ARG =
  "typeof globalThis !== 'undefined' ? globalThis : typeof global !== 'undefined' ? global : typeof window !== 'undefined' ? window : this";

function factoryParams(depMapName: string | undefined): string {
  return depMapName ? FACTORY_PARAMS.replace(DEP_MAP_NAME, depMapName) : FACTORY_PARAMS;
}

/** `__d(function(…) { … });` wrapper for regular modules. */
export function wrapModule(
  body: string,
  globalPrefix: string,
  disableWrapping: boolean,
  depMapName?: string,
): string {
  if (disableWrapping) return body;
  return `${globalPrefix ?? ''}__d(function(${factoryParams(depMapName)}) {\n${body}\n});`;
}

/** `(function(global) { … })(…)` wrapper for polyfills / scripts. */
export function wrapPolyfill(body: string): string {
  return `(function(global) {\n${body}\n})(${GLOBAL_IIFE_ARG});`;
}

/**
 * JSON file wrapper — either `module.exports = …;` (unwrapped) or the Metro
 * factory form. The static-Hermes variant calls `$SHBuiltin.moduleFactory`
 * so the optimised require path picks it up.
 */
export function wrapJson(
  json: string,
  globalPrefix: string,
  disableWrapping: boolean,
  useStaticHermes: boolean,
): string {
  if (disableWrapping) return `module.exports = ${json};`;
  const prefix = globalPrefix ?? '';
  if (useStaticHermes) {
    return `${prefix}__d($SHBuiltin.moduleFactory(${METRO_MODULE_ID}, function(${FACTORY_PARAMS}) {\nmodule.exports = ${json};\n}));`;
  }
  return `${prefix}__d(function(${FACTORY_PARAMS}) {\nmodule.exports = ${json};\n});`;
}

/**
 * The exact prefix `wrapModule` emits before `body`. Used to compute the
 * source-map generated-line shift without re-emitting the wrapper twice.
 */
export function modulePrefix(globalPrefix: string, depMapName: string | undefined): string {
  return `${globalPrefix ?? ''}__d(function(${factoryParams(depMapName)}) {\n`;
}
