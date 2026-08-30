import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Renderer only. The server/cli are emitted by `tsc -p tsconfig.server.json`.
/** `npm run dev` serves index.html from vite, not from our server, so mirror the
 *  server's LIMN_DEV_HOOKS gate here — dev only, never in a built bundle. */
const devHooksMeta = {
  name: 'limn-dev-hooks',
  apply: 'serve' as const,
  transformIndexHtml: (html: string): string =>
    process.env.LIMN_DEV_HOOKS === '1'
      ? html.replace('</head>', '  <meta name="limn-dev" content="1">\n  </head>')
      : html
}

export default defineConfig({
  root: 'src/renderer',
  publicDir: 'public',
  plugins: [react(), devHooksMeta],
  build: { outDir: '../../dist/renderer', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      '/rpc': 'http://127.0.0.1:5466',
      '/events': 'http://127.0.0.1:5466',
      '/health': 'http://127.0.0.1:5466'
    }
  }
})
