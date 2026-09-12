import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The recall benchmark needs a cloned corpus. It runs through
    // `pnpm bench:recall`, which sets APPGUIDE_BENCH.
    exclude: process.env['APPGUIDE_BENCH'] ? configDefaults.exclude : [...configDefaults.exclude, 'bench/**'],
  },
})
