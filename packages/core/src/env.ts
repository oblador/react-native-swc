import type { SwcTransformerOptions } from './types';

/** Capture Expo's dependency-level fetch flag in the serialized worker config. */
export function captureExpoEnvironment(
  config?: SwcTransformerOptions,
  environment: NodeJS.ProcessEnv = process.env,
): SwcTransformerOptions | undefined {
  // Expo's Babel preset inlines this flag even inside node_modules. Capturing
  // it here also makes Metro invalidate cached transforms when it changes.
  const nativeFetch = environment.EXPO_PUBLIC_USE_RN_FETCH;
  if (nativeFetch == null) return config;
  return {
    ...config,
    envs: { EXPO_PUBLIC_USE_RN_FETCH: nativeFetch, ...config?.envs },
  };
}
