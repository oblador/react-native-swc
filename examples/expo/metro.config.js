// Learn more https://docs.expo.io/guides/customizing-metro
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');
const { withSwcTransformer } = require('@react-native-swc/core');

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);

config.watchFolders = [path.resolve(__dirname, '../../node_modules')];

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

module.exports =
  process.env.TRANSFORMER === 'babel' ? config : withSwcTransformer(config, swcConfig);
