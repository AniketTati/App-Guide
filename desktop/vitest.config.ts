import { defineConfig } from 'vitest/config'

// Tests live beside the app, not under the page's root (src/renderer), which
// is where Vite's own config would look.
export default defineConfig({
  root: '.',
  test: { include: ['test/**/*.test.ts'], environment: 'node' },
})
