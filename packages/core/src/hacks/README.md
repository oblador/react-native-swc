# `src/hacks/`

Workarounds for SWC / Metro mismatches. Each file answers three questions:

1. **What does upstream do wrong (or differently) that forces this hack?**
2. **How will we know it's safe to delete?**
3. **What's the cheapest thing we can do in the meantime?**

Every hack here is string-level. None of them participate in the AST
pipeline — that's deliberate: if you find yourself reaching for an AST
walker inside `hacks/`, lift the logic back into `src/swc.ts` or write a
tiny SWC plugin instead.

## Current hacks

| File             | Why it exists                                                                                                                                                                                                                                  | Deletion criteria                                                                                                           |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `esm-residue.ts` | SWC with `isModule: "unknown"` (needed so Flow polyfills' `export type` parses) leaks CJS markers into the polyfill IIFE output. Also strips the bonus `"use strict"` SWC's CJS pass adds to pure-CJS files under `experimentalImportSupport`. | SWC grows a `polyfill` module mode or we drop Flow polyfill support; Metro's `experimentalImportSupport` path gets retired. |

## When adding a new hack

Put it in its own file, export only what `transform-worker.ts` calls, and
write a short header explaining the root cause. If the hack is more than
~150 lines, it probably belongs back in the main pipeline as a proper
transform — file an issue instead.
