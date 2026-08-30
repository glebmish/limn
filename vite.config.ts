import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Renderer only. The server/cli are emitted by `tsc -p tsconfig.server.json`.
export default defineConfig({
  root: 'src/renderer',
  publicDir: 'public',
  plugins: [react()],
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
