import type { RendererApi } from '../shared/ipc'

declare global {
  interface Window {
    api: RendererApi
    limnDev?: {
      flow?: string | null
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
      /** inject a synthetic running review op (tool calls + status) so the live
       *  generation panel can be captured without a real agent run */
      fakeGen?: boolean
      /** seed a synthetic "branch moved since loaded" drift so the titlebar fetch
       *  pill can be captured without a real external commit (collapsed dot only) */
      fakeDrift?: boolean
      /** force the seeded fetch pill open (counts revealed) — the design's is-open
       *  specimen state, for a static expanded capture */
      fakeDriftOpen?: boolean
      /** dev-only: open Settings once the app mounts */
      openSettings?: boolean
      /** open Settings on a tab ('agents' | 'actions') */
      settingsTab?: string
      /** open the chat drawer's action launcher; `launcherPane` picks the pane */
      openLauncher?: boolean
      launcherPane?: string
      /** dev-only: open a spec/plan artifact doc by path once the review mounts */
      openDoc?: string | null
      /** JSON {file,start,end} — open the in-place flow frame for a static capture */
      editFrame?: string | null
      /** JSON {file,line,text} — perform a REAL in-place edit (full save pipeline)
       *  once the review mounts, so the after-save render can be captured */
      runEdit?: string | null
      /** force-show the hover affordances (pencil, rail ↺) for static captures */
      showAffordances?: boolean
      /** JSON scripted-demo steps [{at,do,sel?,key?,meta?,text?}] — dispatches real
       *  DOM events (dblclick/type/key) on a schedule so recordings drive the real UI */
      scenario?: string | null
      /** dev-only: expand a left-spine artifact peek panel by path for a static capture */
      openPeek?: string | null
    }
  }
}

export {}
