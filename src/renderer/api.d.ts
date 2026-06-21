import type { RendererApi } from '../shared/ipc'

declare global {
  interface Window {
    api: RendererApi
    lrDev?: {
      flow: string | null
      openSession?: string | null
      /** dev-only: open the repo hub for this repo path */
      openHub?: string | null
      /** dev-only: start the hub with archived sessions shown */
      showArchived?: boolean
      /** dev-only: scroll the review body to the bottom (capture the volatile band) */
      scrollBottom?: boolean
      // dev-only screenshot hooks
      activeChat?: number | null
      openPicker?: boolean
      /** dev-only: open the merged Workspace control (sessions + checkout) for a static capture */
      openWorkspace?: boolean
      /** dev-only: open the compare RefPicker dropdown for a static capture */
      openCmpRef?: boolean
      /** dev-only: fire the agent picker's onChange to this engine once (proves selection) */
      pickEngine?: string | null
      openChatList?: boolean
      /** JSON FocusTarget — focusAnchor() it once the review mounts */
      focus?: string | null
      /** keep the focus flash + badge on screen (don't auto-clear) for a static capture */
      holdFocus?: boolean
      /** run the unified batch over all queued comments once the review mounts */
      runBatch?: boolean
      /** auto-send one chat message once the chat drawer mounts (screenshot the tool-call log) */
      runChat?: string | null
      /** force tool-call log rows open by index: "all" or a comma list like "1,4" */
      expandTool?: string | null
      /** force the execution-mode dropdown open for a static capture */
      openMode?: boolean
    }
  }
}

export {}
