import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/web/vite.config.ts', 'apps/cli/vitest.config.ts', 'tools/vitest.config.ts'],
    sequence: { shuffle: false },
    testTimeout: 10_000,
  },
});
