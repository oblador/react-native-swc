# react-native-swc

**SWC-powered transformer for Metro**

[![CI](https://github.com/oblador/react-native-swc/actions/workflows/ci.yml/badge.svg)](https://github.com/oblador/react-native-swc/actions/workflows/ci.yml)
[![npm (@react-native-swc/core)](https://img.shields.io/npm/v/@react-native-swc/core?label=react-native-swc)](https://www.npmjs.com/package/react-native-swc)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Follow oblador on GitHub](https://img.shields.io/github/followers/oblador?label=Follow%20%40oblador&style=social)](https://github.com/oblador)
[![Follow trastknast on X](https://img.shields.io/twitter/follow/trastknast?label=Follow%20%40trastknast&style=social)](https://twitter.com/trastknast)

- 🔧 Drop-in replacement for Metro Babel transform worker and minifier
- 🦀 All transformation in Rust, no Babel in sight
- 🏎️ Fast: transform worker is ~8× faster & full real world bundling ~3× faster
- ⚡️ Battery friendly: 15× less CPU utilization
- 🚇 Feature parity with Metro: HMR, inline requires, `Platform.select()` substituion, constant folding, delta bundles etc
- 🔤 Native support for Flow, TypeScript, ESM, CJS, JSX
- 🧵 Worklet/Reanimated support without Babel through custom SWC plugin
- 🔌 Support for SWC plugins and `process.env` inlining
- ⚛️ Expo Plugin for seamless integration

## Install

```sh
yarn add -D @react-native-swc/core
```

If your app uses `react-native-reanimated`:

```sh
yarn add -D @react-native-swc/worklets-plugin
```

## Setup

### Expo (managed / CNG) — config plugin

Add `@react-native-swc/core` to `app.json`:

```json
{
  "expo": {
    "plugins": ["@react-native-swc/core"]
  }
}
```

```sh
npx expo prebuild
```

The plugin writes (or updates) a `metro.config.js` wired up to `withSwcTransformer`. If `react-native-worklets` is listed in your dependencies, the worklets SWC plugin is registered automatically. Any `EXPO_PUBLIC_*` env vars present at metro start are inlined into the bundle, matching Expo's default Babel pipeline. If you already have a manual `withSwcTransformer` call, the plugin leaves your config alone.

Disable worklet auto-detection if needed:

```json
["@react-native-swc/core", { "worklets": false }]
```

> **Note.** Expo config plugins run only during `expo prebuild` (and `eas build`, which invokes prebuild). Running `expo start` alone does not re-run plugins.

### Bare React Native / Expo (manual)

```js
// metro.config.js
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');
const { withSwcTransformer } = require('@react-native-swc/core');

module.exports = withSwcTransformer(mergeConfig(getDefaultConfig(__dirname), {}));
```

For Expo without the config plugin, swap `@react-native/metro-config` for `expo/metro-config`. To match Expo's default `EXPO_PUBLIC_*` env-var inlining, forward those vars through `swcConfig.envs`:

```js
// metro.config.js
const { getDefaultConfig } = require('expo/metro-config');
const { withSwcTransformer } = require('@react-native-swc/core');

/** @type {import('@react-native-swc/core').SwcTransformerOptions} */
const swcConfig = {
  envs: Object.fromEntries(
    Object.entries(process.env).filter(([k, v]) => k.startsWith('EXPO_PUBLIC_')),
  ),
};

module.exports = withSwcTransformer(getDefaultConfig(__dirname), swcConfig);
```

`process.env.EXPO_PUBLIC_FOO` references in your source are then replaced with the literal value at bundle time. Anything not prefixed with `EXPO_PUBLIC_` is left alone.

### Worklets (`react-native-reanimated`) — manual

```js
// metro.config.js
const { getDefaultConfig } = require('@react-native/metro-config');
const { withSwcTransformer } = require('@react-native-swc/core');

/** @type {import('@react-native-swc/core').SwcTransformerOptions} */
const swcConfig = {
  plugins: [
    [
      '@react-native-swc/worklets-plugin',
      {
        pluginVersion: require('react-native-worklets/package.json').version,
      },
    ],
  ],
};

module.exports = withSwcTransformer(getDefaultConfig(__dirname), swcConfig);
```

## Configuration

`withSwcTransformer(metroConfig, swcOptions?)` exposes an intentionally narrow surface — everything that affects Metro correctness is owned by the transform worker:

```ts
interface SwcTransformerOptions {
  plugins?: ReadonlyArray<[string, Record<string, unknown>]>;
  /**
   * `process.env.FOO`-style replacements to inline at build time. Values are
   * JSON-encoded for you and merged with the worker's built-ins (`NODE_ENV`,
   * `EXPO_OS`, …). E.g. `{ API_URL: "https://x" }` replaces
   * `process.env.API_URL` with the literal string `"https://x"`.
   */
  envs?: Record<string, string>;
}
```

### Limitations

- **Custom Babel plugins from `babel.config.js` are not executed.** Reanimated is covered by `@react-native-swc/worklets-plugin` in this repo, for other use cases see [SWC plugin directory](https://plugins.swc.rs).
- **TypeScript sources must be [isolatedModules](https://www.typescriptlang.org/tsconfig#isolatedModules)-compatible.** SWC parses each file in isolation.
- **Flow handling is automatic.** User `.js` files are parsed as Flow only if they carry an `@flow` / `@noflow` pragma or if they first fail to parse as plain JavaScript.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[MIT](./LICENSE).
