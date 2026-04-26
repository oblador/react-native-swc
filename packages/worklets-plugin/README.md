# @react-native-swc/worklets-plugin

SWC plugin that workletizes `'worklet'`-tagged functions for
`react-native-reanimated` / `react-native-worklets`. Drop-in replacement for
the Reanimated Babel plugin, usable with any Metro setup that supports SWC
plugins.

Designed to pair with [`react-native-swc`](https://www.npmjs.com/package/react-native-swc)
but works with any SWC-based toolchain like Rspack/Re.Pack.

## Install

```sh
yarn add -D @react-native-swc/worklets-plugin
```

## Metro setup (via `@react-native-swc/core`)

```js
// metro.config.js
const { getDefaultConfig } = require('expo/metro-config');
const { withSwcTransformer } = require('@react-native-swc/core');

module.exports = withSwcTransformer(getDefaultConfig(__dirname), {
  plugins: [
    [
      '@react-native-swc/worklets-plugin',
      {
        pluginVersion: require('react-native-worklets/package.json').version,
      },
    ],
  ],
});
```

## Plugin options

| Option                       | Type       | Default | Notes                                                                              |
| ---------------------------- | ---------- | ------- | ---------------------------------------------------------------------------------- |
| `bundleMode`                 | boolean    | `false` | Emit bundle-mode output (required by `react-native-worklets` bundle-mode runtime). |
| `disableInlineStylesWarning` | boolean    | `false` | Suppress the dev-only "inline styles inside a worklet" warning.                    |
| `disableSourceMaps`          | boolean    | `false` | Skip attaching a source map to each worklet.                                       |
| `disableWorkletClasses`      | boolean    | `false` | Disable class transform — useful if the runtime doesn't need serialized classes.   |
| `globals`                    | `string[]` | `[]`    | Extra identifiers treated as worklet globals.                                      |
| `relativeSourceLocation`     | boolean    | `false` | Emit relative paths in `__initData.location`.                                      |
| `strictGlobal`               | boolean    | `false` | Reject unknown free variables inside worklets.                                     |
| `pluginVersion`              | string     | `""`    | Stamped into `__initData.version`.                                                 |

## License

[MIT](./LICENSE).
