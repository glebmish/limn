import type { StateCreator } from 'zustand'
import type { ActionDef, AgentRef, EngineId } from '../../shared/types'
import { defaultAgent as defaultAgentFor } from '../../shared/agents'
import { resolveDefaultAgent, DEFAULT_AGENT_PREF_KEY } from '../../shared/prefs'
import { ACTIONS_PREF_KEY, parseActions, serializeActions, type CommandAvailability } from '../../shared/actions'
import { api } from '../lib/api'
import type { AppStore } from './index'
import { useStore } from './index'
import type { PanelKind } from '../lib/panelWidths'
import { PANELS, PREF_KEYS, parseStoredWidth } from '../lib/panelWidths'

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
  /** the reviewer's pinned actions (design board 14), global, in launcher order */
  actions: ActionDef[]
  /** command availability per repo path, as last read/probed (board 14 N2) */
  commands: Record<string, CommandAvailability[]>
  /** every skill name any probe has seen, per engine — the editor's "seen on" list */
  seenCommands: { engine: EngineId; names: string[] }[]
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
  /** Replace the pinned actions (add / edit / delete / reorder) and persist them. */
  setActions(actions: ActionDef[]): Promise<void>
  /** Read the cached availability for a repo (no probe). */
  loadCommands(repo: string): Promise<void>
  /** Probe the engines for a repo (all spawnable ones, or the given subset), showing
   *  `checking` locally while it runs, then store the fresh records. */
  refreshCommands(repo: string, engines?: EngineId[]): Promise<void>
  loadSeenCommands(): Promise<void>
  /** Update a panel's preferred width and persist it. A pointer drag paints the CSS
   *  var imperatively and only reaches the store once, at gesture end, so there's no
   *  write storm to guard against. The caller range-clamps (`clampPanelRange`); the
   *  viewport guard is never stored. */
  setPanelWidth(kind: PanelKind, width: number): void
}

/** Fire-and-forget pref write that still reports a failure in the error strip.
 *  Promise.resolve: test stubs and older call shapes need not return a promise. */
function savePref(key: string, value: string): void {
  Promise.resolve(api().setPref(key, value)).catch((err: unknown) => {
    useStore.setState({ error: err instanceof Error ? err.message : String(err) })
  })
}

export const createPrefsSlice: StateCreator<AppStore, [], [], PrefsSlice> = (set, get) => ({
  defaultAgent: defaultAgentFor('claude'),
  agent: defaultAgentFor('claude'),
  agentSeeded: false,
  sidebarView: 'sections',
  sidebarWidth: PANELS.sidebar.default,
  chatWidth: PANELS.chat.default,
  actions: [],
  commands: {},
  seenCommands: [],

  async loadPrefs() {
    try {
      const prefs = await api().getPrefs()
      const parse = <T,>(k: string, fallback: T): T => {
        try { return prefs[k] != null ? (JSON.parse(prefs[k]) as T) : fallback } catch { return fallback }
      }
      const sidebarView = parse<string>('sidebarView', 'sections')
      const seededAgent = resolveDefaultAgent(prefs)
      set((s) => ({
        defaultAgent: seededAgent,
        // See agentSeeded's doc comment: only seed the next-review pick the
        // first time this runs in a page session, so a Dashboard remount
        // doesn't erase a pick the user already made on a draft review.
        agent: s.agentSeeded ? s.agent : seededAgent,
        agentSeeded: true,
        sidebarView: sidebarView === 'tree' ? 'tree' : 'sections',
        sidebarWidth: parseStoredWidth('sidebar', prefs.sidebarWidth),
        chatWidth: parseStoredWidth('chat', prefs.chatWidth),
        actions: parseActions(prefs[ACTIONS_PREF_KEY])
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
            state: { ...s.loaded.state, agent: a },
            session: { ...s.loaded.session, agent: a } }
        : s.loaded
    }))
  },

  async setDefaultAgent(a) {
    await api().setPref(DEFAULT_AGENT_PREF_KEY, JSON.stringify(a))
    set({ defaultAgent: a, agent: a, agentSeeded: true })
  },

  setSidebarView(v) {
    savePref('sidebarView', JSON.stringify(v))
    set({ sidebarView: v })
  },

  async setActions(actions) {
    set({ actions })
    // callers fire this and forget — report a failed save rather than reject unheard
    try { await api().setPref(ACTIONS_PREF_KEY, serializeActions(actions)) } catch (err) { set({ error: err instanceof Error ? err.message : String(err) }) }
  },

  async loadCommands(repo) {
    const list = await api().commandAvailability(repo)
    set((s) => ({ commands: { ...s.commands, [repo]: list } }))
  },

  async refreshCommands(repo, engines) {
    // show the pulse at once — the probe takes a few seconds per engine
    set((s) => ({
      commands: {
        ...s.commands,
        [repo]: (s.commands[repo] ?? []).map((a) => (!engines || engines.includes(a.engine) ? { ...a, state: 'checking' } : a))
      }
    }))
    const fresh = await api().probeCommands(repo, engines)
    set((s) => {
      const prior = s.commands[repo] ?? []
      const merged = prior.length
        ? prior.map((a) => fresh.find((f) => f.engine === a.engine) ?? a)
        : fresh
      for (const f of fresh) if (!merged.some((m) => m.engine === f.engine)) merged.push(f)
      return { commands: { ...s.commands, [repo]: merged } }
    })
    void get().loadSeenCommands()
  },

  async loadSeenCommands() {
    set({ seenCommands: await api().seenCommands() })
  },

  setPanelWidth(kind, width) {
    const key = PREF_KEYS[kind]
    set({ [key]: width } as Pick<PrefsSlice, 'sidebarWidth'> | Pick<PrefsSlice, 'chatWidth'>)
    savePref(key, JSON.stringify(width))
  }
})
