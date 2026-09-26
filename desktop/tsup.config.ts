import { defineConfig } from 'tsup'

/**
 * The Node side of the app: the main process, the page's bridge, the utility
 * process that reads repositories, and the read-only development server. The
 * reader itself is compiled in from ../src; ts-morph stays a dependency so the
 * packaged app carries TypeScript's parser rather than a copy bundled twice.
 */
export default defineConfig({
  entry: {
    main: 'src/main/main.ts',
    preload: 'src/preload/preload.ts',
    worker: 'src/worker/worker.ts',
    devserver: 'src/dev/server.ts',
  },
  format: ['cjs'],
  outExtension: () => ({ js: '.cjs' }),
  target: 'node20',
  platform: 'node',
  external: ['electron', 'ts-morph'],
  shims: true,
  clean: false,
  sourcemap: false,
})
