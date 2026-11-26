import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config';

/**
 * Load tests: `npx vitest run --config vitest.load.config.ts`.
 *
 * Kept out of the normal suite (they take minutes and saturate the machine) by
 * their `.load.ts` suffix, which the default include pattern does not match.
 */
export default mergeConfig(
  base,
  defineConfig({
    test: {
      include: ['tests/load/**/*.load.ts'],
      testTimeout: 10 * 60_000,
      hookTimeout: 120_000,
    },
  }),
);
