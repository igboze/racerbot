import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@racerbot/shared': path.resolve(__dirname, 'packages/shared/src/index.ts'),
      '@racerbot/db': path.resolve(__dirname, 'packages/db/src/index.ts'),
    },
  },
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
