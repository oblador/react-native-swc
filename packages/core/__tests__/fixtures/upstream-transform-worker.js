// Stand-in for an upstream Metro transform worker (e.g. Expo's). Calls are
// recorded on `globalThis` so the test sees them regardless of how the
// module instance is shared between the test and the worker's `require`.
const calls = (globalThis.__upstreamTransformCalls ??= []);

module.exports = {
  transform(config, projectRoot, filename, data, options) {
    calls.push({ config, projectRoot, filename, data, options });
    return Promise.resolve({
      dependencies: [],
      output: [
        {
          type: 'js/module',
          data: {
            code: '',
            lineCount: 1,
            map: [],
            functionMap: null,
            css: { code: data.toString('utf8') },
          },
        },
      ],
    });
  },
  getCacheKey(config) {
    return `upstream:${config.upstreamCacheSalt ?? ''}`;
  },
};
