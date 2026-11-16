import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@racerbot/shared': path.resolve(__dirname, 'packages/shared/src/index.ts'),
      '@racerbot/db': path.resolve(__dirname, 'packages/db/src/index.ts'),
      '@racerbot/executor': path.resolve(__dirname, 'packages/executor/src/index.ts'),
      '@racerbot/detector': path.resolve(__dirname, 'packages/detector/src/index.ts'),
      '@racerbot/triggers': path.resolve(__dirname, 'packages/triggers/src/index.ts'),
      '@racerbot/api': path.resolve(__dirname, 'packages/api/src/index.ts'),
      '@racerbot/contract': path.resolve(__dirname, 'packages/contract/src/index.ts'),
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
