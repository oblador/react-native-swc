/**
 * Port of @react-native/babel-plugin-codegen for SWC.
 *
 * Uses `@react-native/codegen` to parse the original (typed) source and
 * generate a plain-JS view-config module that replaces the entire file.
 * The generated code is then transformed by SWC like any other module.
 *
 * Coverage matches the upstream Babel plugin: only files where the typed
 * source still carries the `codegenNativeComponent<NativeProps>(…)` generic
 * are picked up. Libraries that publish pre-compiled output with types
 * stripped (`tsc`, `esbuild`, `react-native-builder-bob`, …) fall through
 * to the runtime fallback in `react-native/Libraries/Utilities/codegen
 * NativeComponent.js`. The babel preset has the same blind spot — its AST
 * visitor only fires on a literal `export default codegenNativeComponent(…)`
 * call, which the desugared `var X = …; export { X as default };` shape
 * defeats — so we accept the same coverage rather than reach into each
 * library's `package.json#codegenConfig.jsSrcsDir` and parse the source.
 */
import { basename } from 'node:path';

// ---------------------------------------------------------------------------
// Lazy-loaded codegen dependencies from @react-native/codegen
// ---------------------------------------------------------------------------

let _FlowParser: { new (): { parseString(code: string): unknown } } | null = null;
let _TSParser: { new (): { parseString(code: string): unknown } } | null = null;
let _RNCodegen: {
  generateViewConfig(opts: { libraryName: string; schema: unknown }): string;
} | null = null;

function loadCodegen() {
  if (_RNCodegen) return;

  try {
    _FlowParser = require('@react-native/codegen/src/parsers/flow/parser').FlowParser;
    _TSParser = require('@react-native/codegen/src/parsers/typescript/parser').TypeScriptParser;
    _RNCodegen = require('@react-native/codegen/src/generators/RNCodegen');
  } catch {
    try {
      _FlowParser = require('@react-native/codegen/lib/parsers/flow/parser').FlowParser;
      _TSParser = require('@react-native/codegen/lib/parsers/typescript/parser').TypeScriptParser;
      _RNCodegen = require('@react-native/codegen/lib/generators/RNCodegen');
    } catch {
      throw new Error(
        'react-native-swc: Could not find @react-native/codegen. ' +
          'Make sure it is installed (it ships with react-native).',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns `true` when this file should be replaced by a generated view-config
 * module at build time.
 *
 * The upstream Babel plugin (`@react-native/babel-plugin-codegen`) is
 * AST-aware: it fires only when the file's `ExportDefaultDeclaration` has a
 * `CallExpression` callee named `codegenNativeComponent`. We approximate
 * that with a substring scan for `codegenNativeComponent<` (the angle
 * bracket disambiguates the TS/Flow generic-argument call form from a bare
 * reference). No filename convention is enforced — third-party libraries
 * use names like `NativeSafeAreaProvider.ts` that don't end in
 * `NativeComponent.ts`, and they need codegen to run too.
 *
 * The one false positive we have to neutralise explicitly is the helper
 * module `react-native/Libraries/Utilities/codegenNativeComponent.{js,ts}`
 * itself. Its body declares `function codegenNativeComponent<Props: {…}>(…)`,
 * and the `<` in that generic parameter list is indistinguishable from a
 * call's type-argument list at the substring level. Replacing the helper
 * with a generated view-config object breaks every consumer that imports +
 * calls it — Android paths through the runtime fallback then crash with
 * `codegenNativeComponent is not a function`. Excluded by basename.
 */
export function isCodegenFile(filename: string, src: string): boolean {
  if (!src.includes('codegenNativeComponent<')) return false;
  const base = basename(filename);
  return (
    base !== 'codegenNativeComponent.js' &&
    base !== 'codegenNativeComponent.ts' &&
    base !== 'codegenNativeComponent.tsx'
  );
}

/**
 * Generate the view-config module that replaces the original codegen source.
 *
 * The returned code is plain JavaScript (no Flow / TypeScript) and can be
 * fed directly into SWC for the remaining transforms (JSX, ESM→CJS, etc.).
 */
export function generateCodegenSource(filename: string, src: string): string {
  loadCodegen();

  const isTS = filename.endsWith('.ts') || filename.endsWith('.tsx');
  const parser = isTS ? new _TSParser!() : new _FlowParser!();
  const schema = parser.parseString(src);

  const libraryName = basename(filename).replace(/NativeComponent\.(js|ts|tsx)$/, '');

  return _RNCodegen!.generateViewConfig({ libraryName, schema });
}
