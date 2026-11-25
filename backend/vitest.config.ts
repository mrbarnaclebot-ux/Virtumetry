import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // HARD MONEY RULE: blocks every fetch to *.spaitial.ai from any test.
    setupFiles: ['test/setup-no-spaitial.ts'],
    // Integration suites round-trip to remote Neon; 5 s defaults flake under load.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
