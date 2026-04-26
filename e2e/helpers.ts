/**
 * Primitives for the E2E test suite: boot an iOS simulator, start Metro,
 * build the example app with xcodebuild, install + launch it, then stream
 * the simulator logs and decide whether the app crashed or raised a redbox.
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import net from 'node:net';

// Thresholds for the screenshot-based post-launch verdict.
//
// `redboxRatio` is the fraction of sampled top-quarter pixels whose color
// matches React Native's RedBox dark-red background. A real redbox fills
// most of the top half, so anything above a small noise floor is a fail.
//
// `distinctColors` counts unique quantized colors across a coarse full-
// screen sampling grid. A blank / loading / single-color screen reports
// only a handful. A rendered RN/Expo screen reports dozens.
const REDBOX_RATIO_THRESHOLD = 0.15;
const MIN_DISTINCT_COLORS = 5;

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: 'pipe', ...opts });
}

function shSafe(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return {
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    status: res.status,
  };
}

function getBootedSimulator() {
  const out = sh('xcrun', ['simctl', 'list', 'devices', 'booted', '--json']);
  const { devices } = JSON.parse(out);
  for (const list of Object.values(devices)) {
    for (const dev of list) {
      if (dev.state === 'Booted') return { udid: dev.udid, name: dev.name };
    }
  }
  return null;
}

function ensureBootedSimulator() {
  let sim = getBootedSimulator();
  if (sim) return sim;
  // Boot the first available iOS device.
  const out = sh('xcrun', ['simctl', 'list', 'devices', 'available', '--json']);
  const { devices } = JSON.parse(out);
  for (const [runtime, list] of Object.entries(devices)) {
    if (!runtime.includes('iOS')) continue;
    for (const dev of list) {
      if (dev.isAvailable) {
        sh('xcrun', ['simctl', 'boot', dev.udid]);
        sh('open', ['-a', 'Simulator']);
        // Wait for boot to complete.
        for (let i = 0; i < 30; i++) {
          const { status } = shSafe('xcrun', ['simctl', 'bootstatus', dev.udid]);
          if (status === 0) return { udid: dev.udid, name: dev.name };
        }
        throw new Error(`Simulator ${dev.udid} failed to boot`);
      }
    }
  }
  throw new Error('No iOS simulators available');
}

async function waitForPort(port, host, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const sock = net.createConnection({ port, host }, () => {
        sock.end();
        resolve(true);
      });
      sock.on('error', () => resolve(false));
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for ${host}:${port}`);
}

function isPortFree(port) {
  const res = spawnSync('lsof', ['-i', `tcp:${port}`, '-sTCP:LISTEN', '-t'], {
    encoding: 'utf8',
  });
  return !(res.stdout && res.stdout.trim().length > 0);
}

function listPortHolders(port) {
  const res = spawnSync('lsof', ['-nP', '-iTCP:' + port, '-sTCP:LISTEN'], {
    encoding: 'utf8',
  });
  return (res.stdout || '') + (res.stderr || '');
}

function listPortHolderPids(port) {
  const res = spawnSync('lsof', ['-ti', 'tcp:' + port, '-sTCP:LISTEN'], {
    encoding: 'utf8',
  });
  return (res.stdout || '')
    .split('\n')
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isFinite(n));
}

/**
 * Spawn Metro from the example app's directory. Returns a handle with
 * `.kill()` and `.output` (captured stdout/stderr as a single string).
 *
 * `flavor` selects the CLI — `"react-native"` (default) or `"expo"`. Expo
 * apps need `expo start` because expo-router relies on middleware that
 * plain `react-native start` does not install; using the wrong CLI leaves
 * route resolution broken and the app red-screens once rendered.
 */
async function startMetro({ cwd, port = 8081, flavor = 'react-native' }) {
  // Sequential suites both use :8081, so the previous suite's `afterAll`
  // needs the port free before we bind again. Poll briefly, then error
  // with the holder identity so a genuine leak is diagnosable.
  const deadline = Date.now() + 30_000;
  while (!isPortFree(port)) {
    if (Date.now() > deadline) {
      throw new Error(
        `Port ${port} is already in use — kill the existing Metro process first.\nLISTEN holders:\n${listPortHolders(port)}`,
      );
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  const logChunks = [];
  // @react-native/dev-middleware throws if it detects a test harness
  // (JEST_WORKER_ID / NODE_ENV=test), so we must strip those env vars from
  // the Metro child before spawning it.
  const childEnv = { ...process.env };
  for (const key of Object.keys(childEnv)) {
    if (key.startsWith('JEST_')) delete childEnv[key];
  }
  delete childEnv.NODE_ENV;
  childEnv.RCT_METRO_PORT = String(port);
  childEnv.FORCE_COLOR = '0';
  const args =
    flavor === 'expo'
      ? ['expo', 'start', '--port', String(port), '--clear']
      : ['react-native', 'start', '--port', String(port), '--reset-cache'];
  // Note: we do NOT pass `detached: true`. Under rstest each test file
  // runs in its own worker that exits between files; a detached Metro
  // survives the worker, so even if our `afterAll` issues the kill the
  // process dies alongside the worker before the kernel drops the
  // LISTEN socket. Keeping Metro as a normal child lets the worker's
  // signal-on-exit wiring reap it.
  const proc = spawn('npx', args, {
    cwd,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (c) => logChunks.push(c.toString()));
  proc.stderr.on('data', (c) => logChunks.push(c.toString()));
  await waitForPort(port, '127.0.0.1', 120_000);
  return {
    proc,
    get output() {
      return logChunks.join('');
    },
    async kill() {
      if (!proc.killed) proc.kill('SIGTERM');
      // SIGTERM the wrapper, then poll the port. If anything is still
      // LISTENing after 10s (Metro's node server may daemonise out of
      // the npx group), SIGKILL whoever owns the socket directly so the
      // next suite's `beforeAll` can bind.
      const deadline = Date.now() + 10_000;
      while (!isPortFree(port)) {
        if (Date.now() > deadline) {
          for (const pid of listPortHolderPids(port)) {
            try {
              process.kill(pid, 'SIGKILL');
            } catch {
              // Already dead; ignore.
            }
          }
          await new Promise((r) => setTimeout(r, 500));
          break;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
    },
  };
}

function podInstallIfNeeded(iosDir) {
  if (existsSync(path.join(iosDir, 'Pods')) && existsSync(path.join(iosDir, 'Podfile.lock'))) {
    return;
  }
  sh('pod', ['install'], { cwd: iosDir, stdio: 'inherit' });
}

function expoPrebuildIfNeeded(appDir) {
  if (existsSync(path.join(appDir, 'ios'))) return;
  sh('npx', ['expo', 'prebuild', '--platform', 'ios', '--no-install'], {
    cwd: appDir,
    stdio: 'inherit',
  });
}

/**
 * The example apps depend on @react-native-swc/core via `file:../..`, so pnpm
 * stores a hard-linked snapshot that goes stale whenever `dist/` is
 * rebuilt. Re-run `pnpm install` in the example dir to refresh it — this is
 * a no-op when the copy is already current.
 */
function ensureRnsInstalled(appDir) {
  const distIndex = path.join(
    appDir,
    'node_modules',
    '@react-native-swc',
    'core',
    'dist',
    'index.js',
  );
  if (existsSync(distIndex)) return;
  sh('pnpm', ['install', '--prefer-offline'], {
    cwd: appDir,
    stdio: 'inherit',
  });
}

/**
 * Build the app for the iOS simulator using xcodebuild. Returns the path to
 * the built `.app` bundle in the provided derived-data directory.
 */
function xcodebuildApp({ workspace, scheme, derivedDataPath }) {
  mkdirSync(derivedDataPath, { recursive: true });
  sh(
    'xcodebuild',
    [
      '-workspace',
      workspace,
      '-scheme',
      scheme,
      '-configuration',
      'Debug',
      '-sdk',
      'iphonesimulator',
      '-destination',
      'generic/platform=iOS Simulator',
      '-derivedDataPath',
      derivedDataPath,
      '-quiet',
      'CODE_SIGNING_ALLOWED=NO',
      'build',
    ],
    { stdio: 'inherit' },
  );
  const productsDir = path.join(derivedDataPath, 'Build', 'Products', 'Debug-iphonesimulator');
  const entries = readdirSync(productsDir);
  const appBundle = entries.find((f) => f.endsWith('.app'));
  if (!appBundle) {
    throw new Error(`No .app bundle found in ${productsDir}`);
  }
  return path.join(productsDir, appBundle);
}

function readBundleId(appPath) {
  const plist = path.join(appPath, 'Info.plist');
  const out = sh('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', plist]);
  return out.trim();
}

function installApp(udid, appPath) {
  sh('xcrun', ['simctl', 'install', udid, appPath]);
}

function terminateApp(udid, bundleId) {
  spawnSync('xcrun', ['simctl', 'terminate', udid, bundleId], {
    stdio: 'ignore',
  });
}

function launchApp(udid, bundleId) {
  const out = sh('xcrun', ['simctl', 'launch', udid, bundleId]).trim();
  const pidMatch = out.match(/:\s*(\d+)\s*$/);
  return pidMatch ? Number(pidMatch[1]) : null;
}

function isAppRunning(udid, bundleId) {
  const { stdout } = shSafe('xcrun', ['simctl', 'spawn', udid, 'launchctl', 'list']);
  // Running UIKit apps appear as `<pid>\t<status>\tUIKitApplication:<bundleId>[...]`.
  const prefix = `UIKitApplication:${bundleId}[`;
  return stdout.split('\n').some((l) => l.includes(prefix) && /^\d+\s/.test(l));
}

/**
 * Capture a PNG screenshot of the simulator into `outPath`.
 */
function screenshot(udid, outPath) {
  sh('xcrun', ['simctl', 'io', udid, 'screenshot', outPath]);
}

/**
 * Analyze a PNG screenshot for (a) a visible React Native RedBox and
 * (b) roughly "is the app actually rendering". Uses a Swift helper that
 * samples pixels via CoreGraphics; no Node image-decoding deps required.
 *
 * Returns `{redboxVisible, rendered, redboxRatio, distinctColors}`.
 */
function inspectScreenshot(pngPath) {
  const script = path.join(__dirname, 'screencheck.swift');
  const out = sh('swift', [script, pngPath]).trim();
  const parsed = JSON.parse(out);
  return {
    width: parsed.width,
    height: parsed.height,
    redboxRatio: parsed.redboxRatio,
    distinctColors: parsed.distinctColors,
    redboxVisible: parsed.redboxRatio >= REDBOX_RATIO_THRESHOLD,
    rendered: parsed.distinctColors >= MIN_DISTINCT_COLORS,
  };
}

/**
 * Stream simulator logs scoped to a bundle identifier. Returns a handle with
 * `.stop()` (returns captured output) and `.buffer()` (returns current).
 */
function startLogStream(udid, bundleId) {
  const chunks = [];
  const proc = spawn(
    'xcrun',
    [
      'simctl',
      'spawn',
      udid,
      'log',
      'stream',
      '--level=debug',
      '--style=compact',
      '--predicate',
      `processImagePath CONTAINS "${bundleId.split('.').pop()}" OR senderImagePath CONTAINS "${bundleId.split('.').pop()}"`,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  proc.stdout.on('data', (c) => chunks.push(c.toString()));
  proc.stderr.on('data', (c) => chunks.push(c.toString()));
  return {
    proc,
    buffer() {
      return chunks.join('');
    },
    async stop() {
      if (!proc.killed) proc.kill('SIGTERM');
      // Drain any remaining output.
      await new Promise((r) => setTimeout(r, 250));
      return chunks.join('');
    },
  };
}

export async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export {
  sh,
  shSafe,
  getBootedSimulator,
  ensureBootedSimulator,
  startMetro,
  podInstallIfNeeded,
  expoPrebuildIfNeeded,
  ensureRnsInstalled,
  xcodebuildApp,
  readBundleId,
  installApp,
  launchApp,
  terminateApp,
  isAppRunning,
  startLogStream,
  screenshot,
  inspectScreenshot,
  waitForPort,
  isPortFree,
};
