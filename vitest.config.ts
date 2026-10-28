import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const webSrc = fileURLToPath(new URL('./apps/web/src', import.meta.url));

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
          exclude: ['**/*.int.test.ts', '**/node_modules/**'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'int',
          include: ['packages/*/test/**/*.int.test.ts', 'apps/*/test/**/*.int.test.ts'],
          environment: 'node',
          testTimeout: 30000,
          hookTimeout: 60000,
          fileParallelism: true,
        },
      },
      {
        esbuild: { jsx: 'automatic' },
        resolve: { alias: { '@': webSrc } },
        test: {
          name: 'ui',
          include: ['apps/web/test/ui/**/*.test.tsx'],
          environment: 'jsdom',
          setupFiles: ['apps/web/test/ui/setup.ts'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['packages/core/src/**'],
      thresholds: { lines: 95, branches: 95, functions: 95, statements: 95 },
    },
  },
});
