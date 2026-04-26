/**
 * Expo config plugin that wires `@react-native-swc/core` into `metro.config.js`
 * during `expo prebuild`, so apps in managed / continuous-native-generation
 * workflows don't need to edit their Metro config by hand.
 *
 * Usage (app.json):
 *   "plugins": ["@react-native-swc/core"]
 *
 * If `react-native-worklets` is listed in the app's package.json, the
 * generated Metro config also registers `@react-native-swc/worklets-plugin`
 * so `react-native-reanimated` works out of the box.
 *
 * Behavior when the mod runs:
 *   - No `metro.config.js`             → write a scaffold wired up with
 *                                        `withSwcTransformer`.
 *   - File already contains our        → rewrite the managed block (in case
 *     generated marker                   deps changed).
 *   - File exists with a manual        → leave it alone — the user is already
 *     `withSwcTransformer` reference     wired up.
 *   - File exists without either       → append a managed block that wraps
 *                                        `module.exports` in place.
 */

/* eslint-disable @typescript-eslint/no-var-requires */

import {
  createRunOncePlugin,
  withDangerousMod,
  type ConfigPlugin,
  type Mod,
} from '@expo/config-plugins';

const PLUGIN_NAME = '@react-native-swc/core';
const METRO_TAG_START = '@generated begin react-native-swc — do not edit';
const METRO_TAG_END = '@generated end react-native-swc';

export type ExpoPluginOptions = {
  /**
   * Set to `false` to skip auto-wiring `@react-native-swc/worklets-plugin`
   * even if `react-native-worklets` is installed. Defaults to auto-detect.
   */
  worklets?: boolean;
};

function hasWorkletsDependency(projectRoot: string): boolean {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    return Boolean(
      pkg.dependencies?.['react-native-worklets'] ??
      pkg.devDependencies?.['react-native-worklets'] ??
      pkg.peerDependencies?.['react-native-worklets'],
    );
  } catch {
    return false;
  }
}

function swcConfigLiteral(withWorklets: boolean): string {
  const pluginsBlock = withWorklets
    ? `  plugins: [
    [
      "@react-native-swc/worklets-plugin",
      {
        pluginVersion: require("react-native-worklets/package.json").version,
      },
    ],
  ],
`
    : '';
  // Inline EXPO_PUBLIC_* env vars at bundle time, matching Expo's default
  // Babel pipeline behaviour. Computed at metro start, not at prebuild.
  return `{
${pluginsBlock}  envs: Object.fromEntries(
    Object.entries(process.env).filter(
      ([k, v]) => k.startsWith("EXPO_PUBLIC_") && typeof v === "string",
    ),
  ),
}`;
}

function metroScaffold(withWorklets: boolean): string {
  const literal = swcConfigLiteral(withWorklets);
  return `// Learn more https://docs.expo.io/guides/customizing-metro
const { getDefaultConfig } = require("expo/metro-config");
const { withSwcTransformer } = require("@react-native-swc/core");

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);

/** @type {import('@react-native-swc/core').SwcTransformerOptions} */
const swcConfig = ${literal};

module.exports = withSwcTransformer(config, swcConfig);
`;
}

function metroManagedBlock(withWorklets: boolean): string {
  const literal = swcConfigLiteral(withWorklets);
  return [
    `// ${METRO_TAG_START}`,
    `const { withSwcTransformer: __rnSwcWithSwcTransformer } = require("@react-native-swc/core");`,
    `module.exports = __rnSwcWithSwcTransformer(module.exports, ${literal});`,
    `// ${METRO_TAG_END}`,
    '',
  ].join('\n');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const metroManagedRegExp = new RegExp(
  `\\n?// ${escapeRegExp(METRO_TAG_START)}[\\s\\S]*?// ${escapeRegExp(METRO_TAG_END)}\\n?`,
);

function patchMetroConfig(projectRoot: string, withWorklets: boolean): void {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const metroPath = path.join(projectRoot, 'metro.config.js');

  if (!fs.existsSync(metroPath)) {
    fs.writeFileSync(metroPath, metroScaffold(withWorklets), 'utf8');
    return;
  }

  const src = fs.readFileSync(metroPath, 'utf8');

  if (metroManagedRegExp.test(src)) {
    const next = src.replace(metroManagedRegExp, '\n' + metroManagedBlock(withWorklets));
    if (next !== src) fs.writeFileSync(metroPath, next, 'utf8');
    return;
  }

  if (src.includes('withSwcTransformer')) return;

  const next = src.replace(/\s*$/, '\n\n') + metroManagedBlock(withWorklets);
  fs.writeFileSync(metroPath, next, 'utf8');
}

const withReactNativeSwcBase: ConfigPlugin<ExpoPluginOptions | void> = (config, rawOpts) => {
  const opts = (rawOpts ?? {}) as ExpoPluginOptions;

  const mod: Mod<unknown> = async (c) => {
    if (!c.modRequest.introspect) {
      const withWorklets = opts.worklets ?? hasWorkletsDependency(c.modRequest.projectRoot);
      patchMetroConfig(c.modRequest.projectRoot, withWorklets);
    }
    return c;
  };

  // Run the mod on both platforms — the file is under `projectRoot`, not
  // platform-specific, but registering it on a single platform would miss
  // single-platform prebuilds (`expo prebuild -p android`). The mod is
  // idempotent, so running twice is a no-op.
  let next = withDangerousMod(config, ['ios', mod]);
  next = withDangerousMod(next, ['android', mod]);
  return next;
};

const version: string = (() => {
  try {
    return (require('../package.json') as { version: string }).version;
  } catch {
    return '0.0.0';
  }
})();

const withReactNativeSwc = createRunOncePlugin(withReactNativeSwcBase, PLUGIN_NAME, version);

export default withReactNativeSwc;
module.exports = withReactNativeSwc;
module.exports.default = withReactNativeSwc;
