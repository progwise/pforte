import { defineConfig } from 'vitest/config'

// The tests that need a real browser: they start pforte on a port and drive Chrome. They are not part of
// `pnpm test`; run them with `pnpm test:browser`. Chrome must be installed.
export default defineConfig({
  test: {
    include: ['src/**/*.browser.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
