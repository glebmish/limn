import type { RendererApi } from '../shared/ipc'

declare global {
  interface Window {
    api: RendererApi
    lrDev?: { repo?: string | null; branch?: string | null; flow: string | null }
  }
}

export {}
