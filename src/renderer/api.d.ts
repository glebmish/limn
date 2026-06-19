import type { RendererApi } from '../shared/ipc'

declare global {
  interface Window {
    api: RendererApi
    lrDev?: {
      flow: string | null
      openSession?: string | null
      // dev-only screenshot hooks
      activeChat?: number | null
      openPicker?: boolean
      openChatList?: boolean
      /** JSON FocusTarget — focusAnchor() it once the review mounts */
      focus?: string | null
      /** keep the focus flash + badge on screen (don't auto-clear) for a static capture */
      holdFocus?: boolean
      /** run the unified batch over all queued comments once the review mounts */
      runBatch?: boolean
    }
  }
}

export {}
