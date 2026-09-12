import type { StateCreator } from 'zustand'
import type { AgentRef } from '../../shared/types'
import { defaultAgent } from '../../shared/agents'
import { api } from '../lib/api'
import type { AppStore } from './index'

/** Reviewer preferences persisted across runs — currently just the selected agent.
 *  Loaded on boot (loadPrefs) and written through setAgent. */
export interface PrefsSlice {
  /** the agent selected for creating / regenerating a review */
  agent: AgentRef
  /** Hydrate persisted prefs into the store (called by boot). Parses each stored
   *  value, falling back to the visual default when it's missing or unparseable. */
  loadPrefs(): Promise<void>
  setAgent(a: AgentRef): void
}

export const createPrefsSlice: StateCreator<AppStore, [], [], PrefsSlice> = (set) => ({
  agent: defaultAgent('claude'),

  async loadPrefs() {
    try {
      const prefs = await api().getPrefs()
      const parse = <T,>(k: string, fallback: T): T => {
        try { return prefs[k] != null ? (JSON.parse(prefs[k]) as T) : fallback } catch { return fallback }
      }
      set({
        agent: parse<AgentRef>('agent', defaultAgent('claude'))
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
  }
})
