import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/** The built page may load only its own files. Added at build time only: in
 *  development Vite injects an inline script that this policy would block. */
const contentPolicy = (): Plugin => ({
  name: 'content-policy',
  apply: 'build',
  transformIndexHtml: (html) => html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'">`),
})

// The page, loaded from disk by the app (hence a relative base) or served by
// Vite in development, where /api goes to the read-only dev server.
export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [react(), contentPolicy()],
  build: { outDir: '../../dist/renderer', emptyOutDir: true },
  server: { port: 5199, strictPort: true, proxy: { '^/api/': 'http://127.0.0.1:5198' } },
})
