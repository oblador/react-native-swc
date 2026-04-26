/**
 * Transforms every .js file in a corpus via the Metro transform-worker and
 * exits. Designed to be driven by hyperfine — pick the transformer with
 * TRANSFORMER=swc|babel and the example project with PROJECT=vanilla|expo.
 *
 * Usage:
 *   TRANSFORMER=swc   PROJECT=vanilla node --experimental-strip-types benchmarks/transform.ts
 *   TRANSFORMER=babel PROJECT=expo    node --experimental-strip-types benchmarks/transform.ts
 *   TRANSFORMER=swc   node --experimental-strip-types benchmarks/transform.ts --dir path/to/files
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import * as path from 'node:path';

type TransformerName = 'swc' | 'babel';
type ProjectName = 'vanilla' | 'expo';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

const transformerArg = (process.env.TRANSFORMER ?? 'swc') as TransformerName;
if (transformerArg !== 'swc' && transformerArg !== 'babel') {
  console.error(`TRANSFORMER must be "swc" or "babel" (got "${transformerArg}")`);
  process.exit(1);
}

const projectArg = (process.env.PROJECT ?? 'vanilla') as ProjectName;
if (projectArg !== 'vanilla' && projectArg !== 'expo') {
  console.error(`PROJECT must be "vanilla" or "expo" (got "${projectArg}")`);
  process.exit(1);
}

const PROJECT_DIR = path.join(REPO_ROOT, 'examples', projectArg);

const dirArgIdx = process.argv.indexOf('--dir');
// pnpm with `nodeLinker: hoisted` may resolve `react-native` to either the
// example-local `node_modules/` (when a symlink was created) or to the
// workspace root's hoisted copy. Use Node's actual resolver so the corpus
// path tracks wherever pnpm landed it — git worktrees in particular tend
// to skip the example-local symlink and rely on the hoisted root.
const corpusDir =
  dirArgIdx > -1 ? path.resolve(process.argv[dirArgIdx + 1]) : resolveRnLibrariesFor(PROJECT_DIR);

function resolveRnLibrariesFor(projectDir: string): string {
  const localRequire = createRequire(path.join(projectDir, 'noop.js'));
  try {
    const rnPkg = localRequire.resolve('react-native/package.json');
    return path.join(path.dirname(rnPkg), 'Libraries');
  } catch {
    return path.join(projectDir, 'node_modules/react-native/Libraries');
  }
}

// ---------------------------------------------------------------------------
// Load the transformer via the project's metro.config.js so paths resolve
// the same way Metro would see them at bundle time.
// ---------------------------------------------------------------------------

// SWC's WASM plugin loader resolves bare specifiers (e.g. the worklets
// plugin in expo's metro.config.js) relative to `process.cwd()`, so make the
// project root the cwd before any transform calls.
process.chdir(PROJECT_DIR);

const requireFromProject = createRequire(path.join(PROJECT_DIR, 'noop.js'));
const metroConfig = requireFromProject('./metro.config.js') as {
  transformerPath: string;
  transformer: Record<string, unknown>;
};

// Bare specs like `metro-transform-worker` would normally be resolved by
// Metro itself from its own install; from our dir they're only reachable
// via pnpm's hoisted tree under `.pnpm/node_modules`.
const requireFromPnpmHoist = createRequire(
  path.join(PROJECT_DIR, 'node_modules/.pnpm/node_modules/stub.js'),
);
const resolvedTransformerPath = path.isAbsolute(metroConfig.transformerPath)
  ? metroConfig.transformerPath
  : requireFromPnpmHoist.resolve(metroConfig.transformerPath);
const { transform } = requireFromProject(resolvedTransformerPath) as {
  transform: (
    config: Record<string, unknown>,
    projectRoot: string,
    filename: string,
    data: Buffer,
    options: Record<string, unknown>,
  ) => Promise<unknown>;
};

// `transformVariants` is a Metro-only field the worker doesn't consume.
const { transformVariants: _tv, ...transformerConfig } = metroConfig.transformer as {
  transformVariants?: unknown;
  [k: string]: unknown;
};

const baseOptions = {
  dev: false,
  inlinePlatform: true,
  inlineRequires: false,
  minify: false,
  platform: 'ios' as const,
  type: 'module' as const,
  unstable_transformProfile: 'default' as const,
};

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------

function collectFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__' || entry === '__mocks__' || entry === '__fixtures__') continue;
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...collectFiles(full));
    } else if (entry.endsWith('.js') && !entry.endsWith('.d.js')) {
      out.push(full);
    }
  }
  return out;
}

const filenames = collectFiles(corpusDir).sort();
if (filenames.length === 0) {
  console.error(`No .js files found under ${corpusDir}`);
  process.exit(1);
}

const corpus = filenames.map((filename) => ({
  filename,
  data: readFileSync(filename),
}));

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

for (const { filename, data } of corpus) {
  await transform(transformerConfig, PROJECT_DIR, filename, data, baseOptions);
}
