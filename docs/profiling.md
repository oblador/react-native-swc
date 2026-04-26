# Profiling react-native-swc

How to find hot paths in the JS and Rust halves of the transform-worker.

The pipeline is:

```
input → SWC parse+transform (host-side Rust via @swc/core)
      → metro-plugin WASM passes (Rust → WASM, runs inside transformSync)
      → optional user WASM plugins (e.g. worklets)
      → JS-side dependency rewrite (parseSync + AST walk)
      → wrap + optional minify (host-side Rust again)
```

So a profile that shows "node spends 90% in `transformSync`" is still mostly Rust — you have to drill into `_napi_register_module_v1` / `_swc_core_*` symbols to see which stage. The corollary: the same JS profiler can surface Rust hot paths because everything goes through native frames.

## Ground rules

- Always profile a release WASM. Debug WASM is 10–100× slower and the hot frames look completely different. Run `pnpm -r --filter='./packages/*' run build:wasm` and `pnpm build:ts` first.
- Always warm up. The first run loads the WASM, JITs the parser glue, and pulls source files into the page cache. The hyperfine harnesses already do `--warmup 1`; for ad-hoc commands, run twice and ignore run 1.
- Pin the corpus. Comparing flamegraphs across different file sets is meaningless. The repo's default corpus is `examples/vanilla/node_modules/react-native/Libraries` (≈455 files / 4.7 MB) — start there.
- Disable system noise. Close Slack/Chrome/Docker. macOS Power Mode "High Power" if on a laptop. Run benches twice and compare ratios, not absolute numbers.

## Quick benchmark sanity check

Before profiling, confirm there's actually something to optimize. `transform-benchmark.sh` is the e2e harness:

```sh
./benchmarks/transform-benchmark.sh
```

A 4-cell grid (transformer × project) prints in ~1 minute. If wall time hasn't moved, neither has the hot path — don't profile yet.

## JS profiling (covers everything host-side, including SWC native)

The Node `--prof` flag writes a V8 isolate log that includes both JS and native (C++/Rust) frames the v8 sampler can resolve. It catches our biggest hot paths because `transformSync` is called from JS.

```sh
TRANSFORMER=swc PROJECT=vanilla node --experimental-strip-types --prof \
  benchmarks/transform.ts
node --prof-process isolate-0x*.log > /tmp/prof.txt
head -200 /tmp/prof.txt
```

Read the `[C++]` and `[Shared libraries]` sections — those are where SWC's parser/transform actually live. The `[JavaScript]` section is what we own.

For an interactive flamegraph, [`samply`](https://github.com/mstange/samply) is the best macOS option — works on stripped release binaries, opens in the Firefox profiler UI:

```sh
brew install samply  # or: cargo install --locked samply
samply record -- node --experimental-strip-types benchmarks/transform.ts
```

The merge view lets you fold the SWC frames to see which of our stages dominates (parse vs. transform vs. plugin vs. codegen).

## Rust profiling — host-side (@swc/core)

`@swc/core` is a NAPI module compiled by SWC upstream. We don't control its build but we do control how often we call into it. Treat the SWC native frames as opaque cost centres in `samply` and focus on call counts:

- Each SWC `transformSync` is one parse + multiple visits + one codegen. If you see two `transformSync` frames per file in the flamegraph, that's a redundant pass on our side.
- Each `parseSync` is one parse, no codegen. We have one in [src/dependencies.ts](../packages/react-native-swc/src/dependencies.ts) (`collectRequireRefs`). If it shows twice per file, that's the double-parse described in the dependencies-rewrite section.
- `minifySync` is parse + mangle + codegen. Only fires when `minify: true`.

To verify a JS-side hypothesis (e.g. "we parse twice on this file shape"), instrument with a counter and re-bench rather than re-profiling:

```ts
let parseCalls = 0;
const orig = parseSync;
(globalThis as any).parseSync = (...args: unknown[]) => {
  parseCalls++;
  return orig(...args);
};
// run benchmark; print parseCalls at the end
```

## Rust profiling — our WASM plugins

`samply` cannot decode WASM frames because the WASM runtime executes inside `@swc/core`'s wasmer. To profile WASM-side work, **profile the same Rust code as a native binary** via a criterion bench or test, where samply gets full DWARF symbols.

Criterion benches (when added under `packages/metro-plugin/crates/metro_plugin/benches/`) produce native binaries you can profile directly:

```sh
cargo bench -p metro_plugin --bench inline -- --profile-time 10
samply record -- ./target/release/deps/inline-*  --bench --profile-time 10
```

For one-off measurements without criterion, `cargo flamegraph` is fine:

```sh
cargo install flamegraph
cargo flamegraph -p metro_plugin --bench inline -- --bench
```

The native binary is faster than the WASM build (no wasmer trap overhead), so absolute timings won't match production — but the _ratios_ between visitor methods/passes do, which is what matters for "where is my plugin spending time."

## When to reach for what

| Question                                                         | Tool                                                                              |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Which stage dominates total wall time?                           | `samply` on `transform.ts`                                                        |
| Are we calling `transformSync` / `parseSync` more than expected? | `--prof` + `prof-process`, or a manual call counter                               |
| Where is our WASM plugin spending time?                          | criterion bench → `samply` on the native binary                                   |
| Did a change actually move the needle?                           | hyperfine via `transform-benchmark.sh` (always — flamegraphs lie about magnitude) |
| Is WASM size the bottleneck (worker fork)?                       | `wc -c packages/*/{metro_plugin,worklets}.wasm` before/after                      |

## What to ignore

- Node startup (~100 ms) shows up in every hyperfine run; it's a fixed offset, not a regression.
- The first `transform()` call in a process is 5–10× slower because the WASM plugin hasn't been instantiated yet. Always warm up.
- `process.chdir` / `require.resolve` cost — irrelevant once cached.
