/**
 * Test helpers for the SWC port of metro-transform-plugins.
 *
 * Upstream Metro tests call `compare(plugins, input, expected, opts)` which
 * runs both snippets through Babel (with the plugin applied to `input`, no
 * plugin on `expected`) and asserts the generated code is identical. We mirror
 * that here: apply our plugin to the input, and re-print `expected` via
 * `format()` (parse + emit with no transform) so both sides share the same
 * printing conventions and spacing.
 */

import { format, runPass, type InlineOptions, type InlineRequiresOptions } from './run-pass';

export type { InlineOptions, InlineRequiresOptions };

export function compareInline(code: string, expected: string, options?: InlineOptions): void {
  const actual = format(runPass(code, { pass: 'inline', ...options }));
  expect(actual).toBe(format(expected));
}

export function compareConstantFolding(code: string, expected: string): void {
  const actual = format(runPass(code, { pass: 'constantFolding' }));
  expect(actual).toBe(format(expected));
}

export function compareInlineRequires(
  code: string,
  expected: string,
  options?: InlineRequiresOptions,
): void {
  const actual = format(runPass(code, { pass: 'inlineRequires', ...options }));
  expect(actual).toBe(format(expected));
}
