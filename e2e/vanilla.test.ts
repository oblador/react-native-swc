/**
 * E2E: vanilla React Native example — build + launch in the iOS simulator
 * and verify, visually, that the app renders without a RedBox.
 */

import path from 'node:path';
import { tmpdir } from 'node:os';
import {
  ensureBootedSimulator,
  startMetro,
  podInstallIfNeeded,
  ensureRnsInstalled,
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

const appDir = path.resolve(__dirname, '../examples/vanilla');
const iosDir = path.join(appDir, 'ios');
const workspace = path.join(iosDir, 'vanilla.xcworkspace');
const derivedDataPath = path.join(tmpdir(), 'rn-swc-e2e-vanilla');
const screenshotPath = path.join(tmpdir(), 'rn-swc-e2e-vanilla.png');

const RUNTIME_WAIT_MS = 30_000;
const METRO_PORT = 8081;

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
  podInstallIfNeeded(iosDir);
  appPath = xcodebuildApp({
    workspace,
    scheme: 'vanilla',
    derivedDataPath,
  });
  bundleId = readBundleId(appPath);
  metro = await startMetro({ cwd: appDir, port: METRO_PORT });
});

afterAll(async () => {
  if (bundleId && sim) terminateApp(sim.udid, bundleId);
  if (metro) await metro.kill();
});

test('vanilla app renders in the iOS simulator with no RedBox', async () => {
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
