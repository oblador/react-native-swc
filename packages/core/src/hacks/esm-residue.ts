/**
 * # ESM residue in polyfills
 *
 * Polyfills (`options.type === "script"`) that contain Flow `export type` /
 * `import type` need SWC's parser in `isModule: "unknown"` mode — anything
 * stricter rejects the `export` keyword outright. That mode then drags in
 * SWC's CJS conversion, which adds a `"use strict"` preamble, an
 * `Object.defineProperty(exports, "__esModule", …)` marker, and sometimes a
 * bare `export { };` at EOF.
 *
 * None of those survive the polyfill IIFE wrap (which has no `exports`
 * binding), so this module strips them before the wrap step.
 *
 * Deletion criteria: either SWC grows a dedicated polyfill module mode, or
 * we drop Flow polyfill support entirely.
 */

const ESM_MARKER_RE =
  /^Object\.defineProperty\(exports,\s*["']__esModule["'],\s*\{\s*value:\s*true\s*\}\);\s*\n?/m;
const EMPTY_EXPORT_RE = /\n?[ \t]*export[ \t]*\{[ \t]*\}[ \t]*;?\s*$/m;
const LEADING_USE_STRICT_RE = /^["']use strict["'];\s*\n?/;

export function stripScriptEsmResidue(code: string, originalSource: string): string {
  let out = code.replace(ESM_MARKER_RE, '');
  out = out.replace(EMPTY_EXPORT_RE, '');

  // `"use strict"` is only stripped if the original source didn't have one;
  // otherwise we'd lose a directive the author cared about.
  if (!originalHasUseStrict(originalSource)) {
    out = out.replace(LEADING_USE_STRICT_RE, '');
  }
  return out;
}

/**
 * Check if `experimentalImportSupport` produced ESM-only residue that the
 * regular residue pass missed. Narrower than `stripScriptEsmResidue`
 * because it only targets the `"use strict"` directive SWC inserts for
 * purely-CJS files when experimentalImportSupport is on.
 */
export function stripExperimentalImportResidue(code: string, originalSource: string): string {
  if (originalHasUseStrict(originalSource)) return code;
  return code.replace(LEADING_USE_STRICT_RE, '');
}

function originalHasUseStrict(source: string): boolean {
  const trimmed = source.trimStart();
  return trimmed.startsWith('"use strict"') || trimmed.startsWith("'use strict'");
}
