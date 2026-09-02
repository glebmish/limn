import type { StateCreator } from 'zustand'
import type { AgentRef } from '../../shared/types'
import { defaultAgent } from '../../shared/agents'
import { api } from '../lib/api'
import type { AppStore } from './index'
import type { PanelKind } from '../lib/panelWidths'
import { PANELS, PREF_KEYS, parseStoredWidth } from '../lib/panelWidths'

/** The review rail's left-hand nav layout: guided sections (with the plan-mapped
 *  narration) or a flat directory tree. */
export type SidebarView = 'sections' | 'tree'

/** Reviewer preferences persisted across runs — the selected agent and the rail's
 *  nav layout. Loaded on boot (loadPrefs) and written through setAgent/setSidebarView. */
export interface PrefsSlice {
  /** the agent selected for creating / regenerating a review */
  agent: AgentRef
  /** the review rail's nav layout — sections (default) or tree */
  sidebarView: SidebarView
  /** the review rail's PREFERRED width in px — range-clamped only. The width it is
   *  actually painted at is derived per viewport (see `effectiveWidths`); a narrow
   *  window squeezes the rail without ever overwriting this. */
  sidebarWidth: number
  /** the chat drawer's PREFERRED width in px — see `sidebarWidth` */
  chatWidth: number
  /** Hydrate persisted prefs into the store (called by boot). Parses each stored
   *  value, falling back to the visual default when it's missing or unparseable. */
  loadPrefs(): Promise<void>
  setAgent(a: AgentRef): void
  setSidebarView(v: SidebarView): void
  /** Update a panel's preferred width in memory. Pass `{ persist: true }` to also
   *  write the pref — which is what every caller does, since a pointer drag paints
   *  the CSS var imperatively and only reaches the store once, at gesture end. The
   *  caller range-clamps (`clampPanelRange`); the viewport guard is never stored. */
  setPanelWidth(kind: PanelKind, width: number, opts?: { persist?: boolean }): void
}

export const createPrefsSlice: StateCreator<AppStore, [], [], PrefsSlice> = (set) => ({
  agent: defaultAgent('claude'),
  sidebarView: 'sections',
  sidebarWidth: PANELS.sidebar.default,
  chatWidth: PANELS.chat.default,

  async loadPrefs() {
    try {
      const prefs = await api().getPrefs()
      const parse = <T,>(k: string, fallback: T): T => {
        try { return prefs[k] != null ? (JSON.parse(prefs[k]) as T) : fallback } catch { return fallback }
      }
      const sidebarView = parse<string>('sidebarView', 'sections')
      set({
        agent: parse<AgentRef>('agent', defaultAgent('claude')),
        sidebarView: sidebarView === 'tree' ? 'tree' : 'sections',
        sidebarWidth: parseStoredWidth('sidebar', prefs.sidebarWidth),
        chatWidth: parseStoredWidth('chat', prefs.chatWidth)
      })
    } catch { /* prefs unavailable — visual defaults stand */ }
  },

  setAgent(a) {
    void api().setPref('agent', JSON.stringify(a))
    // The picker (and generate) read the *loaded review's* agent
    // (`loaded.state.agent ?? agent`), so updating only the top-level `agent`
    // is shadowed whenever a review is loaded — the click looked like a no-op.
    // Patch the loaded state/session too so the choice shows and is what
    // generate runs with.
    set((s) => ({
      agent: a,
      loaded: s.loaded
        ? { ...s.loaded,
            state: { ...s.loaded.state, agent: a, engine: a.engine },
            session: { ...s.loaded.session, agent: a, engine: a.engine } }
        : s.loaded
    }))
  },

  setSidebarView(v) {
    void api().setPref('sidebarView', JSON.stringify(v))
    set({ sidebarView: v })
  },

  setPanelWidth(kind, width, opts) {
    const key = PREF_KEYS[kind]
    set({ [key]: width } as Pick<PrefsSlice, 'sidebarWidth'> | Pick<PrefsSlice, 'chatWidth'>)
    if (opts?.persist) void api().setPref(key, JSON.stringify(width))
  }
})
