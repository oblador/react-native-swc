import { getCacheKey } from '../src/transform-worker';

describe('getCacheKey', () => {
  const base = { minifierPath: '', globalPrefix: '' };

  test('changes when swcConfig.plugins is added', () => {
    const bare = getCacheKey(base as never);
    const withPlugins = getCacheKey({
      ...base,
      swcConfig: { plugins: [['a', {}]] },
    } as never);
    expect(bare).not.toEqual(withPlugins);
  });

  test('changes when swcConfig.envs is added', () => {
    const bare = getCacheKey(base as never);
    const withEnvs = getCacheKey({
      ...base,
      swcConfig: { envs: { API_URL: 'https://x' } },
    } as never);
    expect(bare).not.toEqual(withEnvs);
  });

  test('changes differ across plugins and envs variants', () => {
    const a = getCacheKey({
      ...base,
      swcConfig: { plugins: [['a', {}]] },
    } as never);
    const b = getCacheKey({
      ...base,
      swcConfig: { envs: { API_URL: 'https://x' } },
    } as never);
    expect(a).not.toEqual(b);
  });
});
