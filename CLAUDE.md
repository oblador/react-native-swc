# CLAUDE.md

Orientation notes for Claude working in this repo. Keep it current.

## Monorepo layout

This is a pnpm workspace. Root is workspace-only (no published artifact).
All publishable code lives in [packages/](packages/).

- [packages/react-native-swc/](packages/react-native-swc/) —
  The main publishable package: Metro transform worker, minifier, and
  Expo config plugin. Depends on `@react-native-swc/metro-plugin` at
  runtime and resolves its `.wasm` via `require.resolve` when building
  the SWC plugin pipeline. TypeScript source under `src/`. Tests in
  `__tests__/` run with rstest (SWC-based test runner; `describe` /
  `test` / `expect` match the Jest API).

- [packages/metro-plugin/](packages/metro-plugin/)
  (`@react-native-swc/metro-plugin`) —
  SWC WASM plugin that implements Metro's post-transform passes
  (experimental-imports, inline, inline-requires, constant-folding).
  Rust crate under `crates/metro_plugin/`. Each pass is individually
  opt-in via options; production enables all four, tests flip one flag
  at a time via `__tests__/run-pass.ts`.

- [packages/worklets-plugin/](packages/worklets-plugin/)
  (`@react-native-swc/worklets-plugin`) —
  SWC plugin that workletizes `'worklet'`-tagged functions. Rust plugin
  under `crates/worklets/`. Tests exercise the WASM plugin via
  `@swc/core`'s `transformSync`; see `__tests__/run-plugin.ts`.

- [benchmarks/](benchmarks/) — TypeScript bundle-time benchmarks
  (`node --experimental-strip-types benchmarks/transform.ts`).

- [e2e/](e2e/) — iOS simulator end-to-end tests (TypeScript + Swift screenshot helper).

- [examples/vanilla/](examples/vanilla/), [examples/expo/](examples/expo/) —
  Reference apps used by benchmarks and E2E. Each is its own pnpm workspace.

- [.github/workflows/](.github/workflows/) — CI and release pipelines.
  All three packages ship as pure JS/TS + WASM. Release publishes the two plugin
  packages first, then `react-native-swc` so its `workspace:*` refs
  resolve to already-available npm versions.

## Building

```sh
pnpm install
pnpm -r --filter='./packages/*' run build:wasm   # SWC WASM plugins
pnpm build:ts                                     # TypeScript (react-native-swc only)
```

The WASM plugins are the only native build outputs; no NAPI addons.

## Test suites

### Workspace unit + Hermes integration

```sh
pnpm test                                              # every package
pnpm --filter react-native-swc test                    # transform-worker + hermes + cache-key
pnpm --filter @react-native-swc/metro-plugin test      # isolated per-pass tests
pnpm --filter @react-native-swc/worklets-plugin test   # ported reanimated tests
```

Per-package rstest configs (`rstest.config.mts`) live alongside each
package. Tests import TypeScript source directly — no need to run
`build:ts` before running them. Globals (`describe`, `test`, `expect`,
`beforeEach`, …) are enabled via `globals: true` in the config, matching
the Jest API; the custom-matcher augmentation in
`packages/worklets-plugin/__tests__/plugin.test.ts` extends `Assertion`
from `@rstest/core` _and_ the legacy `jest.Matchers` namespace because
rstest's `.not`/`.resolves` chains return an internal interface that
inherits from the latter.

Each package's tests load their WASM plugin through `@swc/core`. All
three suites fail hard with an SWC error if their `.wasm` is missing —
run `pnpm -r --filter='./packages/*' run build:wasm` before `pnpm test`.

### Rust unit tests

```sh
cargo test --workspace --release
```

### iOS simulator E2E (macOS only, ~10 min per suite)

```sh
pnpm test:e2e                                  # runs both serially
pnpm test:e2e -- e2e/vanilla.test.ts
pnpm test:e2e -- e2e/expo.test.ts
```

Config: [e2e/rstest.config.mts](e2e/rstest.config.mts) — 15-min per-test
timeout, `maxWorkers: 1` (both suites use Metro on port 8081).

The suite boots a simulator, builds the example app with `xcodebuild`,
installs + launches it, waits 30 s, screenshots the simulator, and runs
[e2e/screencheck.swift](e2e/screencheck.swift) over the PNG. Verdict is
visual (redbox pixel ratio + distinct-color variety), not string-matched.

## Benchmarks

Bundle-time microbenchmarks for the Metro transform-worker live in
[benchmarks/](benchmarks/). [benchmarks/transform.ts](benchmarks/transform.ts)
loads an example app's `metro.config.js`, walks a corpus of `.js` files
(default: that app's `node_modules/react-native/Libraries`), and runs
each through the resolved transformer. Driven by hyperfine via
[benchmarks/transform-worker.sh](benchmarks/transform-worker.sh),
which sweeps the 4-cell grid of `TRANSFORMER ∈ {swc, babel}` ×
`PROJECT ∈ {vanilla, expo}`:

```sh
./benchmarks/transform-worker.sh
```

Single-run forms (useful when iterating on the harness itself):

```sh
TRANSFORMER=swc   PROJECT=vanilla node --experimental-strip-types benchmarks/transform.ts
TRANSFORMER=babel PROJECT=expo    node --experimental-strip-types benchmarks/transform.ts
TRANSFORMER=swc                   node --experimental-strip-types benchmarks/transform.ts --dir path/to/files
```

The harness `process.chdir`s to the example project root before
transforming. SWC's WASM plugin loader resolves bare plugin specifiers
(e.g. expo's `@react-native-swc/worklets-plugin`) via `process.cwd()`,
so without the chdir the Expo config fails with `failed to get the
node_modules path`.

End-to-end benchmarks bundle the example apps under hyperfine via a
single dispatcher that takes positional example names:

```sh
./benchmarks/bundle.sh vanilla
./benchmarks/bundle.sh expo bluesky
```

[benchmarks/bundle.sh](benchmarks/bundle.sh)
auto-detects the bundle command (`expo export` when `node_modules/expo`
is present, otherwise vanilla `react-native bundle --minify true`) and the
package runner (pnpm/yarn/npx, by walking up to find a lockfile), runs
hyperfine over `TRANSFORMER ∈ {swc, babel}`, then prints JS + Hermes
bytecode bundle sizes for each side.

The in-repo examples (`vanilla`, `expo`) live as workspace packages and
are always set up. The cloned examples are gitignored at
`examples/<name>/` and provisioned by the matching
[benchmarks/setup-&lt;name&gt;.sh](benchmarks/) script — each clones at a pinned
tag, moves the upstream `metro.config.js` aside as
`metro.config.original.js`, and writes a wrapper that conditionally
applies `withSwcTransformer` plus shims for the babel-only pieces of that
app's pipeline. The SWC-side bundle is therefore not byte-identical to the
Babel-side bundle — react-compiler, dotenv inlining,
`transform-remove-console`, and similar babel-only passes don't run under
SWC — but the transform pipeline does the same work on the same modules,
which is what the wall-time comparison measures.

### Comparing two refs (HEAD vs fork point)

[benchmarks/bench.sh](benchmarks/bench.sh) is the same orchestration the
`bench.yml` PR workflow runs. It builds HEAD and the fork point into
independent git worktrees (`/tmp/bench-head`, `/tmp/bench-base`), runs
hyperfine + criterion + bundle-size capture against each, and renders a
markdown comparison via [benchmarks/compare.ts](benchmarks/compare.ts).

```sh
pnpm bench:compare                     # HEAD vs merge-base with master, auto-detect
./benchmarks/bench.sh --base origin/main
./benchmarks/bench.sh --only transformer,metro-plugin
./benchmarks/bench.sh --skip-build     # reuse existing worktrees (fast iteration)
./benchmarks/bench.sh --out report.md  # also write the markdown to a file
```

Auto-detection walks `git diff --name-only base..HEAD` and runs only the
benches whose source files moved — same path filters the workflow uses,
so local results match what CI will post on the PR. Cold first run takes
5–10 min for the worktree builds (pnpm install + WASM + TS); subsequent
runs with `--skip-build` are dominated by the bench wall time itself
(~1–5 min per impacted bench).

Hyperfine handles the head/base ratio with a native confidence interval;
[compare.ts](benchmarks/compare.ts) wraps that in a markdown table and
adds a delta-method 1σ band on top so anything inside ±2σ of unity is
flagged as noise rather than a regression.

### Rust microbenches

Per-pass criterion benches for the metro-plugin live in
[packages/metro-plugin/crates/metro_plugin/benches/](packages/metro-plugin/crates/metro_plugin/benches/).
Each bench parses a small JS fixture once and times only the visitor
against a cloned `Program`. Run with:

```sh
cargo bench -p metro_plugin
```

Throughput is reported in MiB/s so improvements compose across passes.
Use these to validate Rust-side optimizations before rebuilding the WASM
and re-running the e2e harness — the metro-plugin contributes <1% of
end-to-end transform time, so its changes are invisible in `transform.ts`
unless the change is large.

## Opt-in SWC plugins

`react-native-swc` wires in exactly one built-in SWC WASM plugin
(`@react-native-swc/metro-plugin`, resolved via `require.resolve`).
Extra plugins — including `@react-native-swc/worklets-plugin`, needed
by apps using `react-native-reanimated` — are passed through the second
argument of `withSwcTransformer`:

```js
withSwcTransformer(config, {
  plugins: [['@react-native-swc/worklets-plugin', {}]],
});
```

User plugins run **before** the built-in metro-post plugin. Plugins are
referenced by bare package spec; SWC calls `require.resolve(...)` against
it (each package's `main` points at its `.wasm`).

Unit tests that exercise worklet transforms via Metro must pass the
worklets plugin through `baseConfig.swcConfig` (see `baseConfigWithWorklets`
in [packages/react-native-swc/**tests**/transform-worker.test.ts](packages/react-native-swc/__tests__/transform-worker.test.ts)).

## Rebuilding after Rust changes

```sh
pnpm --filter @react-native-swc/metro-plugin run build:wasm
pnpm --filter @react-native-swc/worklets-plugin run build:wasm
pnpm install                                    # refresh example-app links
```

Example apps depend on the workspace packages via `workspace:*` references; pnpm
stores a hard-linked snapshot at install time. Rebuilding the artifact
updates the snapshot in place, but `pnpm install` is still needed after
`dist/` is removed/recreated by tsc.

Expo's bundler cache keys transformed output by plugin path, so reruns may
need `expo start --clear` to pick up a new `.wasm`. The E2E helper
already does this.

## No NAPI

None of the three packages ships a NAPI addon. Both the worklets plugin
and the metro-post plugin are exercised only via their WASM entry
points — production through Metro, tests through `@swc/core`'s
`transformSync` — so the test runner and the production pipeline share
a single code path. The metro-post plugin's passes
(`experimentalImports`, `inline`, `inlineRequires`, `constantFolding`)
are each individually opt-in via options, which is how tests isolate a
single pass.
