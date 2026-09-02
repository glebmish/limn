import type { StateCreator } from 'zustand'
import type { AgentRef } from '../../shared/types'
import { defaultAgent as defaultAgentFor } from '../../shared/agents'
import { resolveDefaultAgent, DEFAULT_AGENT_PREF_KEY } from '../../shared/prefs'
import { api } from '../lib/api'
import type { AppStore } from './index'
import type { PanelKind } from '../lib/panelWidths'
import { PANELS, PREF_KEYS, parseStoredWidth } from '../lib/panelWidths'
import { DIFF_LAYOUTS, type DiffLayout } from './derive'

/** The review rail's left-hand nav layout: guided sections (with the plan-mapped
 *  narration) or a flat directory tree. */
export type SidebarView = 'sections' | 'tree'

/** Reviewer preferences persisted across runs — the selected agent and the rail's
 *  nav layout. Loaded on boot (loadPrefs) and written through setAgent/setSidebarView. */
export interface PrefsSlice {
  /** the reviewer's persisted default agent — the seed for `agent` at boot */
  defaultAgent: AgentRef
  /** the agent selected for creating / regenerating THIS review — seeded from
   *  `defaultAgent` at `loadPrefs`, then per-review from the picker (`setAgent`) */
  agent: AgentRef
  /** internal: has `agent` been seeded from `defaultAgent` yet this page
   *  session? `boot()` re-runs `loadPrefs` on every Dashboard mount, so
   *  without this flag an unrun agent pick on a draft/transient review would
   *  be clobbered by the stored default on a Dashboard round-trip. Seeding
   *  happens once per page load; `defaultAgent` itself still refreshes every
   *  call so a Settings/CLI change is picked up promptly. */
  agentSeeded: boolean
  /** the review rail's nav layout — sections (default) or tree */
  sidebarView: SidebarView
  /** the review rail's PREFERRED width in px — range-clamped only. The width it is
   *  actually painted at is derived per viewport (see `effectiveWidths`); a narrow
   *  window squeezes the rail without ever overwriting this. */
  sidebarWidth: number
  /** the chat drawer's PREFERRED width in px — see `sidebarWidth` */
  chatWidth: number
  /** how every file body lays out its columns (Unified | Split | Multi) — global,
   *  persisted; there is deliberately no per-file override */
  diffLayout: DiffLayout
  /** Hydrate persisted prefs into the store (called by boot). Parses each stored
   *  value, falling back to the visual default when it's missing or unparseable. */
  loadPrefs(): Promise<void>
  /** Select the agent for the next review only — in-memory (and the loaded
   *  review's patch, see below). Never writes the default-agent pref. */
  setAgent(a: AgentRef): void
  /** Change the reviewer's persisted default agent. Writes the `defaultAgent`
   *  pref, then seeds both `defaultAgent` and `agent` from it. Rejects (state
   *  left unchanged) when the server rejects the value. */
  setDefaultAgent(a: AgentRef): Promise<void>
  setSidebarView(v: SidebarView): void
  setDiffLayout(l: DiffLayout): void
  /** Update a panel's preferred width in memory. Pass `{ persist: true }` to also
   *  write the pref — which is what every caller does, since a pointer drag paints
   *  the CSS var imperatively and only reaches the store once, at gesture end. The
   *  caller range-clamps (`clampPanelRange`); the viewport guard is never stored. */
  setPanelWidth(kind: PanelKind, width: number, opts?: { persist?: boolean }): void
}

export const createPrefsSlice: StateCreator<AppStore, [], [], PrefsSlice> = (set) => ({
  defaultAgent: defaultAgentFor('claude'),
  agent: defaultAgentFor('claude'),
  agentSeeded: false,
  sidebarView: 'sections',
  sidebarWidth: PANELS.sidebar.default,
  chatWidth: PANELS.chat.default,
  diffLayout: 'unified',

  async loadPrefs() {
    try {
      const prefs = await api().getPrefs()
      const parse = <T,>(k: string, fallback: T): T => {
        try { return prefs[k] != null ? (JSON.parse(prefs[k]) as T) : fallback } catch { return fallback }
      }
      const sidebarView = parse<string>('sidebarView', 'sections')
      const layout = parse<string>('diffLayout', 'unified')
      const seededAgent = resolveDefaultAgent(prefs)
      set((s) => ({
        defaultAgent: seededAgent,
        // See agentSeeded's doc comment: only seed the next-review pick the
        // first time this runs in a page session, so a Dashboard remount
        // doesn't erase a pick the user already made on a draft review.
        agent: s.agentSeeded ? s.agent : seededAgent,
        agentSeeded: true,
        sidebarView: sidebarView === 'tree' ? 'tree' : 'sections',
        diffLayout: DIFF_LAYOUTS.includes(layout as DiffLayout) ? (layout as DiffLayout) : 'unified',
        sidebarWidth: parseStoredWidth('sidebar', prefs.sidebarWidth),
        chatWidth: parseStoredWidth('chat', prefs.chatWidth)
      }))
    } catch { /* prefs unavailable — visual defaults stand */ }
  },

  setAgent(a) {
    // The picker (and generate) read the *loaded review's* agent
    // (`loaded.state.agent ?? agent`), so updating only the top-level `agent`
    // is shadowed whenever a review is loaded — the click looked like a no-op.
    // Patch the loaded state/session too so the choice shows and is what
    // generate runs with. This is a per-review choice — it never writes the
    // `defaultAgent` pref (use `setDefaultAgent` for that).
    set((s) => ({
      agent: a,
      loaded: s.loaded
        ? { ...s.loaded,
            state: { ...s.loaded.state, agent: a, engine: a.engine },
            session: { ...s.loaded.session, agent: a, engine: a.engine } }
        : s.loaded
    }))
  },

  async setDefaultAgent(a) {
    await api().setPref(DEFAULT_AGENT_PREF_KEY, JSON.stringify(a))
    set({ defaultAgent: a, agent: a, agentSeeded: true })
  },

  setSidebarView(v) {
    void api().setPref('sidebarView', JSON.stringify(v))
    set({ sidebarView: v })
  },

  setDiffLayout(l) {
    void api().setPref('diffLayout', JSON.stringify(l))
    set({ diffLayout: l })
  },

  setPanelWidth(kind, width, opts) {
    const key = PREF_KEYS[kind]
    set({ [key]: width } as Pick<PrefsSlice, 'sidebarWidth'> | Pick<PrefsSlice, 'chatWidth'>)
    if (opts?.persist) void api().setPref(key, JSON.stringify(width))
  }
})
