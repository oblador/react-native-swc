import { defineConfig } from '@rstest/core';

export default defineConfig({
  globals: true,
  testEnvironment: 'node',
  root: __dirname,
  include: ['__tests__/**/*.test.ts'],
});
