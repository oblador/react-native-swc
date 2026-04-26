/**
 * Static-require collection + rewriting.
 *
 * This runs AFTER SWC's main `transformSync` because we want to rewrite the
 * `require("x")` calls that SWC produces from both CJS source and ESM→CJS
 * conversion. We parse the SWC output once with `parseSync`, walk the AST,
 * and splice each literal argument into a `_dependencyMap[N]` reference.
 *
 * FUTURE WORK — fold this into `@react-native-swc/metro-plugin`.
 *   The double-parse (SWC transforms, then we re-parse with SWC) is the
 *   single hottest JS-side cost in the worker. The plan is to add a
 *   require-collection pass to the metro-plugin that emits the dep list
 *   alongside the rewritten code via a sentinel directive, removing the
 *   JS-side parse entirely.
 */
import { parseSync } from '@swc/core';

import { DEP_MAP_NAME } from './wrap';
import type {
  AsyncType,
  ContextMode,
  DynamicRequiresBehavior,
  TransformResultDependency,
} from './types';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RequireRef {
  /** 0-indexed start of the string-literal argument (including quotes). */
  argStart: number;
  /** 0-indexed exclusive end. */
  argEnd: number;
  /** 0-indexed start of the replacement span. */
  replaceStart: number;
  /** 0-indexed exclusive end of the replacement span. */
  replaceEnd: number;
  specifier: string;
  asyncType: AsyncType;
  isOptional: boolean;
  /** True when the require argument is not a string literal. */
  isDynamic?: boolean;
  /** SWC span of the dynamic expression (used for line-number approximation). */
  dynamicExprSpan?: { start: number; end: number };
  contextParams?: ContextParams;
}

export interface ContextParams {
  recursive: boolean;
  filter: { pattern: string; flags: string };
  mode: ContextMode;
}

export interface CollectOptions {
  allowRequireContext?: boolean;
  envValues?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// BytePos anchoring
// ---------------------------------------------------------------------------

// SWC's parser accumulates a global BytePos counter across every parseSync
// call in the process, so `ast.span.start` on its own is not a reliable
// base. Prepending a known-length anchor makes the base recoverable without
// relying on SWC internals.
const SPAN_ANCHOR = '0;';
const SPAN_ANCHOR_LEN = Buffer.byteLength(SPAN_ANCHOR, 'utf8');

// ---------------------------------------------------------------------------
// collectRequireRefs
// ---------------------------------------------------------------------------

/**
 * Parse `code` with SWC and return every `require(…)` call site along with
 * the byte-level replacement span. Covers:
 *
 *   - `require("x")`
 *   - `require.resolve("x")` / `.async` / `.prefetch` / `.resolveWeak`
 *   - `require.context("x", …)` when `allowRequireContext` is true
 *   - `new require("x")` (emitted by the inline-requires plugin)
 *
 * Require calls inside a try block are marked `isOptional: true`.
 *
 * The code is not parsed at all if it contains no literal `require`
 * substring — a cheap text check that skips most dependency-free modules.
 */
export function collectRequireRefs(code: string, options: CollectOptions = {}): RequireRef[] {
  // Cheap gate: skip the parse entirely when the source can't contain any
  // of the dep-bearing call shapes we care about.
  if (!code.includes('require') && !code.includes('_$$_IMPORT_')) {
    return [];
  }
  const allowRequireContext = options.allowRequireContext === true;
  const envValues = options.envValues ?? {};

  const ast = parseSync(SPAN_ANCHOR + code, {
    syntax: 'ecmascript',
    target: 'es2022',
  });
  const base = ast.span.start + SPAN_ANCHOR_LEN;
  const refs: RequireRef[] = [];

  walkRequires(ast, (node, inTryBlock) => {
    handleCall(node, inTryBlock, refs, base, allowRequireContext, envValues);
  });

  return refs;
}

// ---------------------------------------------------------------------------
// transformRequires
// ---------------------------------------------------------------------------

/**
 * Replace every static require argument with `_dependencyMap[N]` and return
 * the deduplicated dependency list. Repeat specifiers (same name + async
 * type + contextParams) share an index.
 *
 * Dynamic requires are NOT touched here; `handleDynamicRequires` owns them.
 *
 * `precollectedStaticRefs` skips the internal parse — pass refs that were
 * already collected from `code` (i.e. before any dynamic-require splicing
 * could have invalidated their byte offsets). Caller is responsible for
 * filtering out dynamic refs.
 */
export function transformRequires(
  code: string,
  options?: CollectOptions,
  precollectedStaticRefs?: ReadonlyArray<RequireRef>,
): { code: string; dependencies: TransformResultDependency[] } {
  const refs =
    precollectedStaticRefs ?? collectRequireRefs(code, options).filter((r) => !r.isDynamic);
  if (refs.length === 0) return { code, dependencies: [] };

  const [dependencies, indexByKey] = buildDependencyList(refs);
  const output = spliceReplacements(code, refs, indexByKey);
  return { code: output, dependencies };
}

function buildDependencyList(
  refs: ReadonlyArray<RequireRef>,
): [TransformResultDependency[], Map<string, number>] {
  const indexByKey = new Map<string, number>();
  const deps: {
    key: string;
    name: string;
    asyncType: AsyncType;
    isOptional: boolean;
    contextParams?: ContextParams;
  }[] = [];

  for (const ref of refs) {
    const key = dependencyKey(ref);
    const existing = indexByKey.get(key);
    if (existing == null) {
      indexByKey.set(key, deps.length);
      deps.push({
        key,
        name: ref.specifier,
        asyncType: ref.asyncType,
        isOptional: ref.isOptional,
        contextParams: ref.contextParams,
      });
      continue;
    }
    // A specifier that appears once required and once optional is recorded
    // as optional (most permissive wins).
    if (ref.isOptional && !deps[existing].isOptional) {
      deps[existing].isOptional = true;
    }
  }

  const dependencies: TransformResultDependency[] = deps.map(
    ({ key, name, asyncType, isOptional, contextParams }) => ({
      name,
      data: {
        key,
        asyncType,
        isESMImport: false,
        isOptional,
        ...(contextParams ? { contextParams } : {}),
        locs: [],
        exportNames: [],
      },
    }),
  );
  return [dependencies, indexByKey];
}

function dependencyKey(ref: RequireRef): string {
  const base = `${ref.specifier}:${ref.asyncType ?? ''}`;
  if (!ref.contextParams) return base;
  const { recursive, filter, mode } = ref.contextParams;
  return `${base}:context:${recursive}:${filter.pattern}:${filter.flags}:${mode}`;
}

function spliceReplacements(
  code: string,
  refs: ReadonlyArray<RequireRef>,
  indexByKey: ReadonlyMap<string, number>,
): string {
  // SWC spans are UTF-8 byte offsets, so we splice on a Buffer. Single pass
  // ascending: copy the gap before each ref, then the replacement, then move
  // on. Avoids the O(N×L) allocation a Buffer.concat-per-ref loop incurs on
  // require-heavy modules (react-native/index.js has ~25 requires).
  const sorted = [...refs].sort((a, b) => a.replaceStart - b.replaceStart);
  const replacements = sorted.map((ref) => {
    const idx = indexByKey.get(dependencyKey(ref))!;
    return Buffer.from(
      ref.contextParams ? `require(${DEP_MAP_NAME}[${idx}])` : `${DEP_MAP_NAME}[${idx}]`,
      'utf8',
    );
  });
  return spliceSinglePass(code, sorted, replacements);
}

function spliceSinglePass(
  code: string,
  sortedRefs: ReadonlyArray<RequireRef>,
  replacements: ReadonlyArray<Buffer>,
): string {
  const buf = Buffer.from(code, 'utf8');
  let outLen = buf.length;
  for (let i = 0; i < sortedRefs.length; i++) {
    outLen += replacements[i].length - (sortedRefs[i].replaceEnd - sortedRefs[i].replaceStart);
  }
  const out = Buffer.allocUnsafe(outLen);
  let srcPos = 0;
  let dstPos = 0;
  for (let i = 0; i < sortedRefs.length; i++) {
    const ref = sortedRefs[i];
    const replacement = replacements[i];
    const gap = ref.replaceStart - srcPos;
    if (gap > 0) {
      buf.copy(out, dstPos, srcPos, ref.replaceStart);
      dstPos += gap;
    }
    replacement.copy(out, dstPos);
    dstPos += replacement.length;
    srcPos = ref.replaceEnd;
  }
  if (srcPos < buf.length) {
    buf.copy(out, dstPos, srcPos);
  }
  return out.toString('utf8');
}

// ---------------------------------------------------------------------------
// Dynamic require handling
// ---------------------------------------------------------------------------

/**
 * Error out or rewrite every `require(expr)` call whose argument isn't a
 * string literal. `'reject'` throws at build time; `'throwAtRuntime'`
 * replaces the call with a runtime throw that Metro uses for node_modules
 * whose source intentionally contains dynamic requires.
 */
export function handleDynamicRequires(
  code: string,
  filename: string,
  behavior: DynamicRequiresBehavior,
  refs: ReadonlyArray<RequireRef>,
): string {
  const dynamic = refs.filter((r) => r.isDynamic);
  if (dynamic.length === 0) return code;

  if (behavior === 'reject') {
    const first = dynamic[0];
    const line = byteOffsetToLine(code, first.dynamicExprSpan?.start ?? first.replaceStart);
    throw new Error(
      `${filename}: Dynamic require is not supported. Encountered a require() call with a non-literal argument at line ${line}.`,
    );
  }

  const sorted = [...dynamic].sort((a, b) => a.replaceStart - b.replaceStart);
  const replacements = sorted.map((ref) => {
    const line = byteOffsetToLine(code, ref.replaceStart);
    return Buffer.from(
      `(function (line) { throw new Error('Dynamic require defined at line ' + line + '; not supported by Metro'); })(${line})`,
      'utf8',
    );
  });
  return spliceSinglePass(code, sorted, replacements);
}

function byteOffsetToLine(code: string, byteOffset: number): number {
  const buf = Buffer.from(code, 'utf8');
  const before = buf.subarray(0, byteOffset).toString('utf8');
  return before.split(/\r\n?|\n|\u2028|\u2029/).length;
}

// ---------------------------------------------------------------------------
// AST walk
// ---------------------------------------------------------------------------

type SwcNode = Record<string, unknown>;
type RequireVisitor = (node: SwcNode, inTryBlock: boolean) => void;

/**
 * Shallow, allocation-conscious AST walk that only recurses into fields
 * containing child nodes. Tracks whether the current node is inside a
 * `TryStatement` so `isOptional` can be set correctly.
 */
function walkRequires(node: unknown, cb: RequireVisitor): void {
  visit(node, cb, false);
}

function visit(node: unknown, cb: RequireVisitor, inTry: boolean): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) visit(item, cb, inTry);
    return;
  }
  const n = node as SwcNode;
  if (typeof n.type === 'string') cb(n, inTry);
  const entersTry = n.type === 'TryStatement';
  for (const key in n) {
    if (key === 'span') continue;
    const val = n[key];
    if (val && typeof val === 'object') visit(val, cb, inTry || entersTry);
  }
}

// ---------------------------------------------------------------------------
// Require-call recognizers
// ---------------------------------------------------------------------------

function handleCall(
  node: SwcNode,
  inTryBlock: boolean,
  refs: RequireRef[],
  base: number,
  allowRequireContext: boolean,
  envValues: Record<string, string>,
): void {
  // `new require("m")` is produced by the inline-requires plugin; for
  // dependency-collection purposes it is equivalent to `require("m")`.
  if (node.type !== 'CallExpression' && node.type !== 'NewExpression') return;

  const callee = node.callee as SwcNode;
  const match = classifyRequireCallee(node.type as string, callee);
  if (!match) return;

  if (match.kind === 'context') {
    if (!allowRequireContext) return;
    pushContext(node, inTryBlock, refs, base, envValues);
    return;
  }

  const args = (node.arguments ?? []) as SwcNode[];
  const arity = match.kind === 'importHelper' ? 2 : 1;
  if (args.length !== arity) return;
  const expr = args[0].expression as SwcNode | undefined;
  if (!expr) return;

  // `_$$_IMPORT_DEFAULT` / `_$$_IMPORT_ALL` are emitted with a string
  // specifier as the first argument by the experimental-imports Rust
  // plugin; they're always static, so dynamic-require handling doesn't
  // apply to them.
  if (expr.type !== 'StringLiteral') {
    if (match.kind === 'importHelper') return;
    const callSpan = node.span as { start: number; end: number };
    refs.push({
      argStart: callSpan.start - base,
      argEnd: callSpan.end - base,
      replaceStart: callSpan.start - base,
      replaceEnd: callSpan.end - base,
      specifier: '',
      asyncType: match.asyncType,
      isOptional: inTryBlock,
      isDynamic: true,
      dynamicExprSpan: expr.span as { start: number; end: number },
    });
    return;
  }

  const span = expr.span as { start: number; end: number };
  refs.push({
    argStart: span.start - base,
    argEnd: span.end - base,
    replaceStart: span.start - base,
    replaceEnd: span.end - base,
    specifier: expr.value as string,
    asyncType: match.asyncType,
    isOptional: inTryBlock,
  });
}

type CalleeMatch =
  | { kind: 'require'; asyncType: AsyncType }
  | { kind: 'importHelper'; asyncType: AsyncType }
  | { kind: 'context' };

function classifyRequireCallee(nodeType: string, callee: SwcNode): CalleeMatch | null {
  if (callee.type === 'Identifier') {
    if (callee.value === 'require') {
      return { kind: 'require', asyncType: null };
    }
    // Emitted by the experimental-imports Rust plugin. The helper call
    // takes `(depMapIndex, specifier)` at runtime — the plugin writes the
    // specifier string into BOTH slots, and this pass rewrites the first
    // slot to `_dependencyMap[N]` like it does for any static require.
    if (callee.value === '_$$_IMPORT_DEFAULT' || callee.value === '_$$_IMPORT_ALL') {
      return { kind: 'importHelper', asyncType: null };
    }
  }
  if (nodeType !== 'CallExpression') return null;
  if (callee.type !== 'MemberExpression') return null;
  const object = callee.object as SwcNode | undefined;
  const property = callee.property as SwcNode | undefined;
  if (!object || !property) return null;
  if (object.type !== 'Identifier' || object.value !== 'require') return null;
  if (property.type !== 'Identifier') return null;
  switch (property.value) {
    case 'resolve':
      return { kind: 'require', asyncType: null };
    case 'async':
      return { kind: 'require', asyncType: 'async' };
    case 'prefetch':
      return { kind: 'require', asyncType: 'prefetching' };
    case 'resolveWeak':
      return { kind: 'require', asyncType: 'weak' };
    case 'context':
      return { kind: 'context' };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// require.context
// ---------------------------------------------------------------------------

function pushContext(
  node: SwcNode,
  inTryBlock: boolean,
  refs: RequireRef[],
  base: number,
  envValues: Record<string, string>,
): void {
  const args = (node.arguments ?? []) as SwcNode[];
  const parsed = parseRequireContextArgs(args, envValues);
  const firstArg = args[0].expression as SwcNode;
  const argSpan = firstArg.span as { start: number; end: number };
  const callSpan = node.span as { start: number; end: number };
  refs.push({
    argStart: argSpan.start - base,
    argEnd: argSpan.end - base,
    replaceStart: callSpan.start - base,
    replaceEnd: callSpan.end - base,
    specifier: parsed.directory,
    asyncType: null,
    isOptional: inTryBlock,
    contextParams: parsed.contextParams,
  });
}

function parseRequireContextArgs(
  args: SwcNode[],
  envValues: Record<string, string>,
): { directory: string; contextParams: ContextParams } {
  if (!Array.isArray(args) || args.length < 1) {
    throw new Error('require.context requires at least one argument');
  }

  const directoryExpr = args[0].expression as SwcNode;
  const directory = resolveStringExpr(directoryExpr, envValues);
  if (directory == null) {
    throw new Error('First argument of require.context must resolve to a static string directory');
  }

  let recursive = true;
  if (args.length > 1) {
    const expr = args[1].expression as SwcNode;
    const resolved = resolveBooleanExpr(expr, envValues);
    if (resolved != null) recursive = resolved;
    else if (!isUndefinedExpr(expr))
      throw new Error('Second argument of require.context must be an optional boolean');
  }

  let filter = { pattern: '.*', flags: '' };
  if (args.length > 2) {
    const expr = args[2].expression as SwcNode;
    if (expr?.type === 'RegExpLiteral') {
      filter = {
        pattern: String(expr.pattern ?? '.*'),
        flags: String(expr.flags ?? ''),
      };
    } else if (!isUndefinedExpr(expr)) {
      throw new Error('Third argument of require.context must be an optional RegExp literal');
    }
  }

  let mode: ContextMode = 'sync';
  if (args.length > 3) {
    const expr = args[3].expression as SwcNode;
    const resolved = resolveStringExpr(expr, envValues);
    if (resolved != null) mode = asContextMode(resolved);
    else if (!isUndefinedExpr(expr))
      throw new Error('Fourth argument of require.context must be an optional mode string');
  }

  if (args.length > 4) {
    throw new Error(
      `Too many arguments provided to require.context. Expected 4, got ${args.length}`,
    );
  }

  return { directory, contextParams: { recursive, filter, mode } };
}

function asContextMode(mode: string): ContextMode {
  if (mode === 'sync' || mode === 'eager' || mode === 'lazy' || mode === 'lazy-once') {
    return mode;
  }
  throw new Error(
    `require.context "${mode}" mode is not supported. Expected one of: sync, eager, lazy, lazy-once`,
  );
}

function isUndefinedExpr(expr: SwcNode | undefined): boolean {
  return expr?.type === 'Identifier' && expr.value === 'undefined';
}

function resolveStringExpr(
  expr: SwcNode | undefined,
  envValues: Record<string, string>,
): string | null {
  if (!expr) return null;
  if (expr.type === 'StringLiteral') return String(expr.value);
  const envKey = readProcessEnvKey(expr);
  if (envKey && envValues[envKey] != null) return envValues[envKey];
  return null;
}

function resolveBooleanExpr(
  expr: SwcNode | undefined,
  envValues: Record<string, string>,
): boolean | null {
  if (!expr) return null;
  if (expr.type === 'BooleanLiteral') return Boolean(expr.value);
  const envKey = readProcessEnvKey(expr);
  if (envKey && envValues[envKey] != null) {
    if (envValues[envKey] === 'true') return true;
    if (envValues[envKey] === 'false') return false;
  }
  return null;
}

/** Recognise `process.env.FOO` and return `"FOO"`, or `null` otherwise. */
function readProcessEnvKey(expr: SwcNode | undefined): string | null {
  if (!expr || expr.type !== 'MemberExpression') return null;
  const outerObject = expr.object as SwcNode | undefined;
  const outerProperty = expr.property as SwcNode | undefined;
  if (!outerObject || !outerProperty) return null;
  if (outerObject.type !== 'MemberExpression') return null;
  const innerObject = outerObject.object as SwcNode | undefined;
  const innerProperty = outerObject.property as SwcNode | undefined;
  if (!innerObject || !innerProperty) return null;
  if (innerObject.type !== 'Identifier' || innerObject.value !== 'process') return null;
  if (innerProperty.type !== 'Identifier' || innerProperty.value !== 'env') return null;
  if (outerProperty.type === 'Identifier') return String(outerProperty.value);
  if (outerProperty.type === 'StringLiteral') return String(outerProperty.value);
  return null;
}
