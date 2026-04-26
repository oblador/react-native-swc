# @react-native-swc/metro-plugin

SWC WASM plugin that implements Metro's post-transform passes:

| Pass                  | Purpose                                                                                                                            |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `experimentalImports` | Rewrites ESM imports to CJS-shaped `var X = require("m").X` so `inlineRequires` can recognise them.                                |
| `inline`              | `Platform.OS`, `Platform.select({...})` substitution. (`__DEV__` / `process.env.NODE_ENV` are handled by SWC's optimizer globals.) |
| `inlineRequires`      | Moves top-level `var X = require("m")` aliases to each use site; supports `memoizeCalls`.                                          |
| `constantFolding`     | Folds `true && x`, `'ios' === 'android' ? a : b`, constant `if` branches.                                                          |

Each pass is individually opt-in via options — production (via
`react-native-swc`) turns them on together; tests flip one flag at a
time.

## Install

```sh
yarn add -D @react-native-swc/metro-plugin
```

Normally you don't configure this package directly — [`react-native-swc`](../react-native-swc)
depends on it and wires it into Metro's SWC plugin pipeline automatically.

## License

[MIT](./LICENSE).
