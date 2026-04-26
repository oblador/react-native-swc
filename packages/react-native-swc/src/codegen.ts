/**
 * Port of @react-native/babel-plugin-codegen for SWC.
 *
 * Uses `@react-native/codegen` to parse the original (typed) source and
 * generate a plain-JS view config module that replaces the entire file.
 * The generated code is then transformed by SWC like any other module.
 */

import { basename } from 'path';

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
 * Returns `true` when the source contains a `codegenNativeComponent<` call
 * that needs to be replaced at build time.
 */
export function isCodegenFile(src: string): boolean {
  return src.includes('codegenNativeComponent<');
}

/**
 * Generate the view-config module that replaces the original codegen source.
 *
 * The returned code is plain JavaScript (no Flow / TypeScript) and can be fed
 * directly into SWC for the remaining transforms (JSX, ESM→CJS, etc.).
 */
export function generateCodegenSource(filename: string, src: string): string {
  loadCodegen();

  const isTS = filename.endsWith('.ts') || filename.endsWith('.tsx');
  const parser = isTS ? new _TSParser!() : new _FlowParser!();
  const schema = parser.parseString(src);

  const libraryName = basename(filename).replace(/NativeComponent\.(js|ts|tsx)$/, '');

  return _RNCodegen!.generateViewConfig({ libraryName, schema });
}
