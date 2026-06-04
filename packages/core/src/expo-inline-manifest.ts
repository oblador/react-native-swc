const RESTRICTED_MANIFEST_FIELDS = [
  'androidNavigationBar',
  'androidStatusBar',
  'privacy',
  // Remove iOS and Android.
  'ios',
  'android',
  // Hide internal / build values
  'plugins',
  'hooks', // hooks no longer exists in the typescript type but should still be removed
  '_internal',
  // Remove metro-specific values
  'assetBundlePatterns',
] as const;

let configMemo: ExpoConfigMemo | null | undefined;

export function getExpoAppManifest(projectRoot: string): string | null {
  if (process.env.APP_MANIFEST) {
    return process.env.APP_MANIFEST;
  }

  const exp = getExpoConstantsManifest(projectRoot);
  if (exp) {
    return JSON.stringify(exp);
  }
  return null;
}

function getExpoConstantsManifest(projectRoot: string): ExpoConfigRecord | null {
  const config = getConfigMemo(projectRoot);
  if (!config) return null;

  const manifest = applyWebDefaults(config);

  for (const field of RESTRICTED_MANIFEST_FIELDS) {
    delete manifest[field];
  }

  return manifest;
}

function getConfigMemo(projectRoot: string): ExpoConfigMemo | null {
  if (configMemo !== undefined) {
    return configMemo;
  }

  let expoConfig: unknown;
  try {
    // This is an optional dependency. In practice, it will resolve in all Expo projects/apps
    // since `expo` is a direct dependency in those. If this package is used independently
    // this will fail and we won't return a config.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    expoConfig = require('expo/config');
  } catch (error) {
    if (isModuleNotFound(error)) {
      return (configMemo = null);
    }
    throw error;
  }

  const { getConfig, getNameFromConfig } = expoConfig as {
    getConfig: (
      root: string,
      options: { isPublicConfig: boolean; skipSDKVersionRequirement: boolean },
    ) => { exp: ExpoConfigRecord };
    getNameFromConfig: (config: ExpoConfigRecord) => { appName: string; webName: string };
  };

  const config = getConfig(projectRoot, {
    isPublicConfig: true,
    skipSDKVersionRequirement: true,
  });
  // rn-cli apps use a displayName value as well.
  const { appName, webName } = getNameFromConfig(config.exp);
  return (configMemo = {
    config,
    appName,
    webName,
  });
}

type ExpoConfigRecord = Record<string, any>;

interface ExpoConfigMemo {
  config: { exp: ExpoConfigRecord };
  appName: string;
  webName: string;
}

function applyWebDefaults({ config, appName, webName }: ExpoConfigMemo): ExpoConfigRecord {
  const appJSON = config.exp;
  // For RN CLI support
  const webManifest = appJSON.web ?? {};
  const splash = appJSON.splash ?? {};
  const ios = appJSON.ios ?? {};
  const android = appJSON.android ?? {};
  const languageISOCode = webManifest.lang;
  const primaryColor = appJSON.primaryColor;
  const description = appJSON.description;
  // The theme_color sets the color of the tool bar, and may be reflected in the app's preview in task switchers.
  const webThemeColor = webManifest.themeColor || primaryColor;
  const dir = webManifest.dir;
  const shortName = webManifest.shortName || webName;
  const display = webManifest.display;
  const startUrl = webManifest.startUrl;
  const { scope, crossorigin } = webManifest;
  const barStyle = webManifest.barStyle;
  const orientation = ensurePWAOrientation(webManifest.orientation || appJSON.orientation);
  /**
   * **Splash screen background color**
   * `https://developers.google.com/web/fundamentals/web-app-manifest/#splash-screen`
   * The background_color should be the same color as the load page,
   * to provide a smooth transition from the splash screen to your app.
   */
  const backgroundColor = webManifest.backgroundColor || splash.backgroundColor; // No default background color

  return {
    ...appJSON,
    name: appName,
    description,
    primaryColor,
    ios: { ...ios },
    android: { ...android },
    web: {
      ...webManifest,
      meta: undefined,
      build: undefined,
      scope,
      crossorigin,
      description,
      startUrl,
      shortName,
      display,
      orientation,
      dir,
      barStyle,
      backgroundColor,
      themeColor: webThemeColor,
      lang: languageISOCode,
      name: webName,
    },
  };
}

// Convert expo value to PWA value
function ensurePWAOrientation(orientation: unknown): string | undefined {
  if (orientation) {
    const webOrientation = String(orientation).toLowerCase();
    if (webOrientation !== 'default') {
      return webOrientation;
    }
  }
  return undefined;
}

function isModuleNotFound(error: unknown): error is { code: 'MODULE_NOT_FOUND' } {
  return (
    typeof error === 'object' &&
    error != null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'MODULE_NOT_FOUND'
  );
}
