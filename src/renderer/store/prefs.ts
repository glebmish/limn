import type { StateCreator } from 'zustand'
import type { AgentRef } from '../../shared/types'
import { defaultAgent } from '../../shared/agents'
import { api } from '../lib/api'
import type { AppStore } from './index'

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
  /** Hydrate persisted prefs into the store (called by boot). Parses each stored
   *  value, falling back to the visual default when it's missing or unparseable. */
  loadPrefs(): Promise<void>
  setAgent(a: AgentRef): void
  setSidebarView(v: SidebarView): void
}

export const createPrefsSlice: StateCreator<AppStore, [], [], PrefsSlice> = (set) => ({
  agent: defaultAgent('claude'),
  sidebarView: 'sections',

  async loadPrefs() {
    try {
      const prefs = await api().getPrefs()
      const parse = <T,>(k: string, fallback: T): T => {
        try { return prefs[k] != null ? (JSON.parse(prefs[k]) as T) : fallback } catch { return fallback }
      }
      const sidebarView = parse<string>('sidebarView', 'sections')
      set({
        agent: parse<AgentRef>('agent', defaultAgent('claude')),
        sidebarView: sidebarView === 'tree' ? 'tree' : 'sections'
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
  }
})
