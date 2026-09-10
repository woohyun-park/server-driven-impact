import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/server-driven-impact/**/*.test.ts'],
    environment: 'node',
    maxWorkers: 2,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
