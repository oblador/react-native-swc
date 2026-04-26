const path = require('path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');
const { withSwcTransformer } = require('@react-native-swc/core');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const config = {
  watchFolders: [path.resolve(__dirname, '../../node_modules')],
  resolver: {
    // pnpm places a realpath copy of every transitive package under
    // `../../node_modules/.pnpm/...`, so without a custom resolver
    // Metro ends up with two distinct `react/index.js` entries — one
    // reached via this app's own `node_modules/react` and one when a
    // package (e.g. `react-native-safe-area-context`) resolves `react`
    // from its pnpm realpath. Pin every request for `react` /
    // `react-native` (and their subpaths like `react/jsx-dev-runtime`)
    // to this app's copy so React's dispatcher is shared.
    resolveRequest: (context, moduleName, platform) => {
      const pinned = ['react', 'react-native'];
      for (const base of pinned) {
        if (moduleName === base || moduleName.startsWith(base + '/')) {
          const rest = moduleName.slice(base.length);
          return context.resolveRequest(
            context,
            path.join(__dirname, 'node_modules', base) + rest,
            platform,
          );
        }
      }
      return context.resolveRequest(context, moduleName, platform);
    },
  },
};

const defaultConfig = mergeConfig(getDefaultConfig(__dirname), config);

module.exports =
  process.env.TRANSFORMER === 'babel' ? defaultConfig : withSwcTransformer(defaultConfig);
