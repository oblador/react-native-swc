/**
 * Aggregate hyperfine + criterion + bundle-size results into a single
 * markdown report for the bench CI workflow.
 *
 * The bench jobs run hyperfine with `--parameter-list ref head,base`, so each
 * hyperfine JSON contains both the head and base measurements for one bench
 * — we don't need to diff two files. We just regroup by ref, compute the
 * head/base ratio with a confidence interval (delta-method on hyperfine's
 * mean ± stddev), and emit one row per bench.
 *
 * Criterion benches still run twice (cargo bench has no native ref-as-param
 * support); each run emits libtest "bencher" output. We parse both files
 * and produce a delta table with the same shape.
 *
 * Bundle sizes come from a single JSON-per-example with `{head, base}` keys.
 *
 * Usage:
 *   node --experimental-strip-types benchmarks/compare.ts \
 *     --dir path/to/aggregated-results \
 *     [--out report.md]
 *
 * Inside `--dir`, expected layout:
 *
 *   transform-<project>.json     — hyperfine, refs as a parameter
 *   bundle-<example>.json        — hyperfine, refs as a parameter
 *   size-<example>.json          — { head: { js, hbc }, base: { js, hbc } }
 *   cargo-<crate>-head.txt       — bencher format from `cargo bench`
 *   cargo-<crate>-base.txt       — bencher format from `cargo bench`
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

interface HyperfineRun {
  command: string;
  mean: number; // seconds
  stddev: number;
  min: number;
  max: number;
  parameters?: Record<string, string>;
}
interface HyperfineExport {
  results: HyperfineRun[];
}
interface SizeReport {
  head?: { js: number; hbc: number };
  base?: { js: number; hbc: number };
}

const args = parseArgs(process.argv.slice(2));
if (!args.dir) {
  console.error('usage: compare.ts --dir <results-dir> [--out <file>]');
  process.exit(1);
}

const sections: string[] = [];

renderHyperfineGroup('Transform-worker', 'transform');
renderHyperfineGroup('Bundle time', 'bundle');
renderCriterionGroup('metro-plugin', 'cargo-metro_plugin');
renderCriterionGroup('worklets-plugin', 'cargo-worklets');
renderSizeGroup();

const out =
  sections.length === 0
    ? '_No benchmark results to compare._\n'
    : ['## Benchmarks vs. fork point', '', ...sections].join('\n');

if (args.out) {
  writeFileSync(args.out, out);
} else {
  process.stdout.write(out);
}

// ---------------------------------------------------------------------------
// Hyperfine: refs come in as a parameter dimension; one JSON per bench.
// ---------------------------------------------------------------------------

function renderHyperfineGroup(title: string, prefix: string): void {
  const files = listMatchingByPrefix(args.dir, prefix);
  if (files.length === 0) return;

  const rows: string[] = [];
  rows.push(`### ${title}`);
  rows.push('');
  rows.push('| Bench | Base | Head | Δ | Ratio (head / base) |');
  rows.push('|---|---|---|---|---|');

  let any = false;
  for (const { name, file } of files.sort((a, b) => a.name.localeCompare(b.name))) {
    const data = readJson<HyperfineExport>(file);
    if (!data) continue;
    const head = pickByRef(data.results, 'head');
    const base = pickByRef(data.results, 'base');
    if (!head || !base) continue;
    rows.push(
      `| ${name} | ${formatMs(base)} | ${formatMs(head)} | ${formatDelta(base.mean, head.mean)} | ${formatRatio(head, base)} |`,
    );
    any = true;
  }
  rows.push('');
  if (any) sections.push(rows.join('\n'));
}

/** Find every `<dir>/<prefix>-<name>.json`, returning the captured names + paths. */
function listMatchingByPrefix(dir: string, prefix: string): Array<{ name: string; file: string }> {
  if (!existsSync(dir)) return [];
  const out: Array<{ name: string; file: string }> = [];
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(`${prefix}-`) && entry.endsWith('.json')) {
      const name = entry.slice(prefix.length + 1, -'.json'.length);
      out.push({ name, file: path.join(dir, entry) });
    }
  }
  return out;
}

function pickByRef(results: HyperfineRun[], ref: 'head' | 'base'): HyperfineRun | undefined {
  // Hyperfine exposes the substituted parameter values in `parameters`.
  // Older versions only have `command`, so fall back to a substring match.
  for (const r of results) {
    if (r.parameters && r.parameters.ref === ref) return r;
  }
  for (const r of results) {
    if (r.command.includes(`ref=${ref}`)) return r;
    if (r.command.includes(`/${ref}/`)) return r;
    if (r.command.includes(`/${ref} `)) return r;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Criterion: two bencher-format files, one per ref.
// ---------------------------------------------------------------------------

function renderCriterionGroup(title: string, prefix: string): void {
  const baseFile = path.join(args.dir, `${prefix}-base.txt`);
  const headFile = path.join(args.dir, `${prefix}-head.txt`);
  if (!existsSync(baseFile) && !existsSync(headFile)) return;

  const baseEntries = parseBencher(readText(baseFile));
  const headEntries = parseBencher(readText(headFile));
  const all = new Map<string, { base?: number; head?: number }>();
  for (const [name, ns] of baseEntries) all.set(name, { base: ns });
  for (const [name, ns] of headEntries) {
    const slot = all.get(name) ?? {};
    slot.head = ns;
    all.set(name, slot);
  }
  if (all.size === 0) return;

  const rows: string[] = [];
  rows.push(`### Criterion: ${title}`);
  rows.push('');
  rows.push('| Bench | Base | Head | Δ |');
  rows.push('|---|---|---|---|');
  for (const [name, { base: b, head: h }] of [...all.entries()].sort()) {
    const baseS = b != null ? formatNs(b) : 'n/a';
    const headS = h != null ? formatNs(h) : 'n/a';
    const delta = b != null && h != null ? formatDelta(b, h) : h != null ? '🆕' : '🗑️';
    rows.push(`| \`${name}\` | ${baseS} | ${headS} | ${delta} |`);
  }
  rows.push('');
  sections.push(rows.join('\n'));
}

// ---------------------------------------------------------------------------
// Bundle size: one JSON per example with both refs.
// ---------------------------------------------------------------------------

function renderSizeGroup(): void {
  const files = listMatching(args.dir, /^size-(.+)\.json$/);
  if (files.length === 0) return;

  const rows: string[] = [];
  rows.push('### Bundle size (SWC, iOS)');
  rows.push('');
  rows.push('| Example | Base JS | Head JS | Δ JS | Base HBC | Head HBC | Δ HBC |');
  rows.push('|---|---|---|---|---|---|---|');
  let any = false;
  for (const name of files.sort()) {
    const data = readJson<SizeReport>(path.join(args.dir, `size-${name}.json`));
    if (!data) continue;
    const fmt = (n?: number) => (n == null ? 'n/a' : `${(n / 1024).toFixed(1)} KB`);
    const delta = (a?: number, b?: number) => (a == null || b == null ? '—' : formatDelta(a, b));
    rows.push(
      `| ${name} | ${fmt(data.base?.js)} | ${fmt(data.head?.js)} | ${delta(data.base?.js, data.head?.js)} | ` +
        `${fmt(data.base?.hbc)} | ${fmt(data.head?.hbc)} | ${delta(data.base?.hbc, data.head?.hbc)} |`,
    );
    any = true;
  }
  rows.push('');
  if (any) sections.push(rows.join('\n'));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { dir: string; out?: string } {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      out[a.slice(2)] = argv[i + 1];
      i++;
    }
  }
  return out as { dir: string; out?: string };
}

function readJson<T>(file: string): T | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

function readText(file: string): string {
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

function listMatching(dir: string, pattern: RegExp): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const m = entry.match(pattern);
    if (m) out.push(m[1]);
  }
  return out;
}

/** Parse `cargo bench -- --output-format=bencher` text. */
function parseBencher(text: string): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  const re = /^test\s+(\S+)\s+\.\.\.\s+bench:\s+([\d_,]+)\s+ns\/iter/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push([m[1], parseInt(m[2].replace(/[_,]/g, ''), 10)]);
  }
  return out;
}

function formatMs(r: HyperfineRun): string {
  return `${(r.mean * 1000).toFixed(0)} ms ± ${(r.stddev * 1000).toFixed(0)}`;
}

function formatNs(ns: number): string {
  if (ns >= 1e6) return `${(ns / 1e6).toFixed(2)} ms`;
  if (ns >= 1e3) return `${(ns / 1e3).toFixed(2)} µs`;
  return `${ns} ns`;
}

function formatDelta(base: number, head: number): string {
  const pct = ((head - base) / base) * 100;
  const sign = pct >= 0 ? '+' : '';
  let marker = '';
  if (pct > 2) marker = ' ⚠️';
  else if (pct < -2) marker = ' ✅';
  return `${sign}${pct.toFixed(1)}%${marker}`;
}

/**
 * head/base ratio with a delta-method 1σ uncertainty band:
 *   r = mh / mb,   σr/r ≈ √( (σh/mh)² + (σb/mb)² )
 *
 * Anything inside `1 ± σr` is statistically indistinguishable from the
 * fork point at 1σ — i.e. probably noise. The marker is set on a 2σ
 * threshold so we don't flag every 5 % wobble as a regression.
 */
function formatRatio(head: HyperfineRun, base: HyperfineRun): string {
  const r = head.mean / base.mean;
  const relSigmaSq = (head.stddev / head.mean) ** 2 + (base.stddev / base.mean) ** 2;
  const sigmaR = r * Math.sqrt(relSigmaSq);
  const significant = Math.abs(r - 1) > 2 * sigmaR;
  let marker = '';
  if (significant) marker = r < 1 ? ' ✅' : ' ⚠️';
  return `${r.toFixed(3)} ± ${sigmaR.toFixed(3)}${marker}`;
}
