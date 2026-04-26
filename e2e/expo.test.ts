/**
 * E2E: Expo example — prebuild the iOS project (if needed), build + launch
 * in the iOS simulator, verify visually that the app renders without a
 * RedBox.
 */

import path from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync, readdirSync } from 'node:fs';
import {
  ensureBootedSimulator,
  startMetro,
  expoPrebuildIfNeeded,
  ensureRnsInstalled,
  podInstallIfNeeded,
  xcodebuildApp,
  readBundleId,
  installApp,
  launchApp,
  terminateApp,
  isAppRunning,
  screenshot,
  inspectScreenshot,
  sleep,
} from './helpers';

const appDir = path.resolve(__dirname, '../examples/expo');
const derivedDataPath = path.join(tmpdir(), 'rn-swc-e2e-expo');
const screenshotPath = path.join(tmpdir(), 'rn-swc-e2e-expo.png');

const RUNTIME_WAIT_MS = 30_000;
// React Native iOS apps bake in port 8081 at build time (RCT_METRO_PORT
// defaults there). Use the same port for both example apps — maxWorkers=1
// in e2e/jest.config.js serializes the two suites so they don't collide.
const METRO_PORT = 8081;

function findWorkspaceAndScheme(iosDir: string) {
  const entries = readdirSync(iosDir);
  const workspaceName = entries.find((f) => f.endsWith('.xcworkspace'));
  if (!workspaceName) {
    throw new Error(`No .xcworkspace in ${iosDir} — did prebuild fail?`);
  }
  const scheme = workspaceName.replace(/\.xcworkspace$/, '');
  return {
    workspace: path.join(iosDir, workspaceName),
    scheme,
  };
}

let sim: { udid: string; name: string };
let metro: Awaited<ReturnType<typeof startMetro>>;
let bundleId: string;
let appPath: string;

beforeAll(async () => {
  if (process.platform !== 'darwin') {
    throw new Error('E2E tests require macOS');
  }
  sim = ensureBootedSimulator();
  ensureRnsInstalled(appDir);
  expoPrebuildIfNeeded(appDir);
  const iosDir = path.join(appDir, 'ios');
  if (!existsSync(iosDir)) {
    throw new Error(`expo prebuild did not produce ${iosDir}`);
  }
  podInstallIfNeeded(iosDir);
  const { workspace, scheme } = findWorkspaceAndScheme(iosDir);
  appPath = xcodebuildApp({ workspace, scheme, derivedDataPath });
  bundleId = readBundleId(appPath);
  metro = await startMetro({ cwd: appDir, port: METRO_PORT, flavor: 'expo' });
});

afterAll(async () => {
  if (bundleId && sim) terminateApp(sim.udid, bundleId);
  if (metro) await metro.kill();
});

test('expo app renders in the iOS simulator with no RedBox', async () => {
  installApp(sim.udid, appPath);
  const pid = launchApp(sim.udid, bundleId);
  expect(pid).not.toBeNull();

  await sleep(RUNTIME_WAIT_MS);

  const running = isAppRunning(sim.udid, bundleId);
  screenshot(sim.udid, screenshotPath);
  const visual = inspectScreenshot(screenshotPath);

  if (!running || visual.redboxVisible || !visual.rendered) {
    const metroOut = metro.output.slice(-4000);
    throw new Error(
      [
        `app running: ${running} (launched pid ${pid})`,
        `screenshot: ${screenshotPath}`,
        `  redboxRatio:    ${visual.redboxRatio.toFixed(3)} (threshold ${0.15})`,
        `  distinctColors: ${visual.distinctColors} (min ${5})`,
        `  redbox visible: ${visual.redboxVisible}`,
        `  rendered:       ${visual.rendered}`,
        '--- metro output (tail) ---',
        metroOut,
      ].join('\n'),
    );
  }

  expect(running).toBe(true);
  expect(visual.redboxVisible).toBe(false);
  expect(visual.rendered).toBe(true);
});
