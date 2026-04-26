# Contributing

Thanks for wanting to hack on `react-native-swc`. This project is a pnpm
workspace with three publishable packages; the native code lives in Rust and is
compiled to a WASM SWC plugin.

## Setup

```
mise install
rustup target add wasm32-wasip1
corepack enable
pnpm install
```

## First-time setup

```sh
pnpm build
```

## Everyday tasks

| Command                            | Does                                                 |
| ---------------------------------- | ---------------------------------------------------- |
| `pnpm build`                       | Build TS & Rust code                                 |
| `pnpm test`                        | Rstest unit + Hermes integration tests               |
| `pnpm typecheck`                   | `tsc --noEmit` across every package                  |
| `pnpm format`                      | oxfmt — write                                        |
| `pnpm format:check`                | oxfmt — check                                        |
| `cargo test --workspace --release` | Rust unit tests                                      |
| `pnpm bench`                       | Metro full-bundle benchmark (SWC vs Babel)           |
| `pnpm test:e2e`                    | iOS simulator E2E (macOS only, useful as AI harness) |

Expo caches transformed output by plugin path — if you're iterating on the
worklets plugin inside `examples/expo`, restart Metro with
`expo start --clear`.

### Repo layout

```
react-native-swc/
├── packages/
│   ├── react-native-swc/          ← main package: Metro transform-worker
│   │   ├── src/                   TypeScript: transform-worker, minifier,
│   │   │                          codegen, expo-plugin
│   │   └── __tests__/             Rstest (TS) — worker + hermes + cache-key
│   ├── metro-plugin/              ← SWC ports of Metro's post-transform passes
│   │   ├── crates/metro_plugin/   Rust: single WASM plugin with toggleable passes
│   │   └── __tests__/             Rstest (TS) — isolated per-pass tests
│   └── worklets-plugin/           ← reanimated support
│       ├── crates/worklets/       Rust: SWC plugin
│       └── __tests__/             Rstest (TS) — ported reanimated plugin tests
├── benchmarks/                    TypeScript transformer/bundle-time benchmarks
├── e2e/                           iOS simulator E2E (TS + Swift screenshot helper)
├── examples/{vanilla,expo}/       Reference apps used by benchmarks & E2E
└── .github/workflows/             CI (lint, typecheck, cargo clippy, build &
                                   test on each host) + release (pnpm publish)
```

## Submitting changes

1. Open an issue or draft PR early if the change is non-trivial.
2. Add or update tests. New behaviours without coverage are unlikely to
   land.
3. Run `pnpm format` and make sure `pnpm test && pnpm typecheck && cargo
test --workspace` pass locally.
4. Commit messages: short imperative subject line, extra context in the body
   if useful.

## Release process

Releases are cut by pushing an annotated `v*` tag to `main`.
