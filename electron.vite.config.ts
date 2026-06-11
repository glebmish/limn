import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        external: ['@anthropic-ai/claude-agent-sdk', '@openai/codex-sdk']
      }
    }
  },
  preload: {},
  renderer: {
    plugins: [react()]
  }
})
