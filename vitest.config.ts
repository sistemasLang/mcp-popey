import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Integration tests start a disposable PostgreSQL container.
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
