import { defineConfig } from '@rstest/core';

export default defineConfig({
  globals: true,
  testEnvironment: 'node',
  root: __dirname,
  include: ['*.test.ts'],
  testTimeout: 15 * 60 * 1000,
  hookTimeout: 15 * 60 * 1000,
  // Both suites bind Metro to :8081, so they MUST run serially. Set both
  // `maxWorkers` (caps pooled test workers) AND `pool.maxWorkers` (caps
  // the worker pool itself). Without the latter, rstest still spawns a
  // worker per test file in parallel — vanilla's beforeAll bootstraps
  // Metro on 8081 while expo's beforeAll races to do the same.
  pool: { maxWorkers: 1 },
});
