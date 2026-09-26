import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The recall benchmark needs a cloned corpus. It runs through
    // `pnpm bench:recall`, which sets APPGUIDE_BENCH.
    // desktop/ is its own package with its own tests.
    exclude: process.env['APPGUIDE_BENCH'] ? [...configDefaults.exclude, 'desktop/**'] : [...configDefaults.exclude, 'bench/**', 'desktop/**'],
  },
})
