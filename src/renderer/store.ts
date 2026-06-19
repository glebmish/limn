import { create } from 'zustand'
import type { CliOpenMsg, CompareData, DashboardData, LoadedReview } from '../shared/ipc'
import type { AgentRef, ChatThread, Comment, CommentAnchor, EngineEvent, EngineId, FileDiff, PinNode, RepoInfo, RepoStatus, Section } from '../shared/types'
import { defaultAgent } from '../shared/agents'

export type Density = 'compact' | 'comfortable' | 'spacious'
export type Guidance = 'minimal' | 'guided' | 'narrated'

export const ACCENTS: string[][] = [
  ['#3a7d54', '#2c6342', '#e7efe9', '#bcd6c5'],
  ['#46505d', '#33363d', '#ecedf0', '#d2d6dc'],
  ['#3a6ea5', '#2b5680', '#e6eef6', '#bdd2e6'],
  ['#8a5a3c', '#6c4327', '#f3e9e0', '#e0cbb8']
]

let opCounter = 0
export function newOpId(): string {
  return `op-${Date.now()}-${++opCounter}`
}

/** Fallback grouping before AI annotations exist: one section per top-level dir. */
export function synthesizeSections(files: FileDiff[]): Section[] {
  const byDir = new Map<string, string[]>()
  for (const f of files) {
    const dir = f.path.includes('/') ? f.path.split('/')[0] : 'top-level'
    byDir.set(dir, [...(byDir.get(dir) ?? []), f.path])
  }
  return [...byDir.entries()].map(([dir, paths], i) => ({
    id: `dir-${dir}`,
    name: dir === 'top-level' ? 'Top-level files' : dir + '/',
    desc: '',
    what: '',
    files: paths,
    order: i + 1,
    flags: []
  }))
}

export function effectiveSections(loaded: LoadedReview | null): Section[] {
  if (!loaded) return []
  return loaded.state.annotations?.sections ?? synthesizeSections(loaded.skeleton.files)
}

export interface GenState {
  running: boolean
  opId: string | null
  kind: 'review' | 'chat' | 'fix' | null
  /** for chat ops: which thread the streamed tokens belong to */
  threadId: number | null
  log: EngineEvent[]
  error: string | null
}

/** The active chat thread (or a sensible default) within the loaded review. */
export function activeChat(loaded: LoadedReview | null, activeChatId: number | null): ChatThread | null {
  const chats = loaded?.state.chats ?? []
  return chats.find((c) => c.id === activeChatId) ?? null
}

/** Keep the current chat if still present; else default to the empty user chat
 *  (the second default chat), else the last chat, else none. */
function pickActiveChat(chats: ChatThread[], current: number | null): number | null {
  if (current != null && chats.some((c) => c.id === current)) return current
  const emptyUser = [...chats].reverse().find((c) => c.kind === 'user' && c.messages.length === 0 && !c.engineSessionId)
  return (emptyUser ?? chats[chats.length - 1])?.id ?? null
}

interface AppStore {
  screen: 'dashboard' | 'compare' | 'review'
  recents: string[]
  repo: string | null
  repoInfo: RepoInfo | null
  branch: string
  base: string
  /** the agent selected for creating / regenerating a review */
  agent: AgentRef
  loaded: LoadedReview | null
  sessionId: number | null
  activeChatId: number | null
  /** whether the chat drawer is open (lifted here so an agent-identity click in
   *  the review can open a specific chat). */
  chatOpen: boolean
  error: string | null

  // dashboard
  dashboard: DashboardData | null
  filter: string
  sel: number
  statuses: Record<string, RepoStatus>

  // compare
  compare: {
    repo: string | null
    repoInfo: RepoInfo | null
    baseInput: string
    compareInput: string
    data: CompareData | null
    loading: boolean
    retargetSessionId: number | null
  }

  viewedAt: Record<string, string>
  reviewedSections: Set<string>
  collapsed: Set<string>
  cur: string | null
  /** transient: force-render a focus target (a viewed file / reviewed section)
   *  without mutating viewedAt/reviewedSections. Set by focusAnchor. */
  focusTarget: { file?: string; sectionId?: string } | null

  density: Density
  guidance: Guidance
  accent: string[]

  gen: GenState

  boot(): Promise<void>
  applyCliOpen(msg: CliOpenMsg): void
  // dashboard
  loadDashboard(): Promise<void>
  setFilter(s: string): void
  pinDirectory(): Promise<void>
  openRepository(): Promise<void>
  unpin(id: number): Promise<void>
  rescan(id: number): Promise<void>
  // compare
  enterCompare(repoPath: string, refs?: { base?: string; compare?: string }, opts?: { retargetSessionId?: number | null }): Promise<void>
  setBaseInput(s: string): void
  setCompareInput(s: string): void
  swapRefs(): void
  refreshCompare(): Promise<void>
  startFromCompare(): Promise<void>
  resumeExisting(sessionId: number): Promise<void>
  startFresh(sessionId: number): Promise<void>
  applyRetarget(): Promise<void>
  backToDashboard(): void
  backToCompare(): void
  retarget(side: 'base' | 'compare'): void
  // review
  setAgent(a: AgentRef): void
  reload(): Promise<void>
  toggleViewed(file: string, currentlyViewed: boolean): void
  markReviewed(id: string): void
  openSection(id: string): void
  setCur(id: string): void
  setFocusTarget(t: { file?: string; sectionId?: string } | null): void
  setTweak(key: 'density' | 'guidance' | 'accent', value: unknown): void
  startOp(kind: 'review' | 'chat' | 'fix', opId: string, threadId?: number): void
  pushOpEvent(ev: EngineEvent): void
  finishOp(error?: string): void
  setComments(comments: Comment[]): void
  // chat
  switchChat(id: number): void
  openChat(threadId?: number): void
  closeChat(): void
  newChat(): Promise<void>
  setActiveChatAgent(a: AgentRef): Promise<void>
  sendChat(text: string, anchor?: CommentAnchor): void
  /** the unified batch turn: send comments to a thread's agent (edits+commits code). */
  sendBatch(threadId: number, commentIds: string[], steer?: string): void
  deleteChat(id: number): Promise<void>
}

export const useStore = create<AppStore>((set, get) => {
  const persistUi = (): void => {
    const { sessionId, viewedAt, reviewedSections } = get()
    if (sessionId == null) return
    void window.api.saveUiState(sessionId, { viewedAt, reviewedSections: [...reviewedSections] })
  }

  /** Splice an updated chat-thread list into the loaded review. */
  const setChats = (chats: ChatThread[]): void => {
    const loaded = get().loaded
    if (loaded) set({ loaded: { ...loaded, state: { ...loaded.state, chats } } })
  }

  let compareTimer: ReturnType<typeof setTimeout> | null = null
  let compareGen = 0
  let rescanRunning = false

  /** Walk a dashboard's pin trees + recents into the flat list of repo paths. */
  const collectRepoPaths = (d: DashboardData): string[] => {
    const out: string[] = []
    const walk = (pinPath: string, node: PinNode): void => {
      if (node.kind === 'repo') out.push(node.relPath ? `${pinPath}/${node.relPath}` : pinPath)
      node.children.forEach((c) => walk(pinPath, c))
    }
    for (const pin of d.pins) { if (pin.tree) walk(pin.path, pin.tree) }
    for (const r of d.recents) out.push(r)
    return [...new Set(out)]
  }

  /** Fill branch/dirty status in chunks of 8 without blocking render. */
  const fillStatuses = async (paths: string[]): Promise<void> => {
    for (let i = 0; i < paths.length; i += 8) {
      const chunk = paths.slice(i, i + 8)
      const got = await window.api.repoStatus(chunk)
      set({ statuses: { ...get().statuses, ...got } })
    }
  }

  return {
    screen: 'dashboard',
    recents: [],
    repo: null,
    repoInfo: null,
    branch: '',
    base: '',
    agent: defaultAgent('claude'),
    loaded: null,
    sessionId: null,
    activeChatId: null,
    chatOpen: typeof window !== 'undefined' && window.lrDev?.flow === 'chat',
    error: null,

    dashboard: null,
    filter: '',
    sel: 0,
    statuses: {},

    compare: { repo: null, repoInfo: null, baseInput: '', compareInput: '', data: null, loading: false, retargetSessionId: null },

    viewedAt: {},
    reviewedSections: new Set<string>(),
    collapsed: new Set<string>(),
    cur: null,
    focusTarget: null,

    density: 'comfortable',
    guidance: 'guided',
    accent: ACCENTS[0],

    gen: { running: false, opId: null, kind: null, threadId: null, log: [], error: null },

    async boot() {
      try {
        // one-time migration of localStorage tweaks into the db
        if (!localStorage.getItem('lr-prefs-migrated')) {
          for (const key of ['density', 'guidance', 'accent', 'engine']) {
            const v = localStorage.getItem(`lr-${key}`)
            if (v != null) await window.api.setPref(key, v)
          }
          localStorage.setItem('lr-prefs-migrated', '1')
        }
        const prefs = await window.api.getPrefs()
        const parse = <T,>(k: string, fallback: T): T => {
          try { return prefs[k] != null ? (JSON.parse(prefs[k]) as T) : fallback } catch { return fallback }
        }
        // legacy formats: bare 'codex' (seeded from old config.json) or JSON '"codex"' (localStorage migration)
        const legacyEngine: EngineId = prefs['engine'] === 'codex' || prefs['engine'] === '"codex"' ? 'codex' : 'claude'
        set({
          density: parse<Density>('density', 'comfortable'),
          guidance: parse<Guidance>('guidance', 'guided'),
          accent: parse<string[]>('accent', ACCENTS[0]),
          agent: parse<AgentRef>('agent', defaultAgent(legacyEngine))
        })
      } catch { /* prefs unavailable — visual defaults stand */ }
      await get().loadDashboard()
      // Apply a pending CLI open AFTER the dashboard has loaded — otherwise its
      // error toast (e.g. "<dir> is not inside a git repository") races with,
      // and is clobbered by, loadDashboard's `error: null` reset. takeCliOpen
      // also marks the renderer ready, so later second-instance forwards arrive
      // live via onCliOpen (wired in App.tsx).
      try {
        const cli = await window.api.takeCliOpen()
        if (cli) get().applyCliOpen(cli)
      } catch { /* no pending cli open */ }
      // dev/screenshot: LR_OPEN_SESSION auto-resumes a seeded session onto Review
      const openSession = window.lrDev?.openSession
      if (openSession) await get().resumeExisting(Number(openSession))
    },

    applyCliOpen(msg) {
      if (msg.error) { set({ error: msg.error }); return }
      if (msg.repo) void get().enterCompare(msg.repo, { base: msg.baseInput, compare: msg.compareInput })
    },

    async loadDashboard() {
      try {
        const dashboard = await window.api.dashboard()
        set({ dashboard, recents: dashboard.recents, error: null })
        if (dashboard.notices.length > 0) set({ error: dashboard.notices.join(' ') })
        void fillStatuses(collectRepoPaths(dashboard))
        // spec: render instantly from cache, then refresh in the background.
        // rescanPin returns the FULL dashboard each time; applying the last
        // result covers every pin. One loop at a time — re-entry is dropped.
        if (!rescanRunning && dashboard.pins.length > 0) {
          rescanRunning = true
          void (async () => {
            try {
              let latest = dashboard
              for (const pin of dashboard.pins) latest = await window.api.rescanPin(pin.id)
              set({ dashboard: latest, recents: latest.recents })
              void fillStatuses(collectRepoPaths(latest))
            } catch { /* background refresh is best-effort */
            } finally {
              rescanRunning = false
            }
          })()
        }
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err) })
      }
    },

    setFilter(s) {
      set({ filter: s, sel: 0 })
    },

    async openRepository() {
      // escape hatch: open a one-off repo without pinning; openRepo (inside
      // enterCompare) records it, so it shows up under Recent afterwards
      const dir = await window.api.pickRepo()
      if (dir) await get().enterCompare(dir)
    },

    async pinDirectory() {
      const dir = await window.api.pickRepo()
      if (!dir) return
      try {
        const dashboard = await window.api.addPin(dir)
        set({ dashboard, recents: dashboard.recents, error: null })
        void fillStatuses(collectRepoPaths(dashboard))
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err) })
      }
    },

    async unpin(id) {
      const dashboard = await window.api.removePin(id)
      set({ dashboard, recents: dashboard.recents })
      void fillStatuses(collectRepoPaths(dashboard))
    },

    async rescan(id) {
      const dashboard = await window.api.rescanPin(id)
      set({ dashboard, recents: dashboard.recents })
      void fillStatuses(collectRepoPaths(dashboard))
    },

    async enterCompare(repoPath, refs, opts) {
      set({
        screen: 'compare',
        compare: { repo: repoPath, repoInfo: null, baseInput: '', compareInput: '', data: null, loading: true, retargetSessionId: opts?.retargetSessionId ?? null },
        error: null
      })
      try {
        const info = await window.api.openRepo(repoPath)
        const baseInput = refs?.base ?? info.defaultBase
        const compareInput = refs?.compare ?? (info.current !== 'HEAD' ? info.current : info.branches[0] ?? '')
        set({ compare: { ...get().compare, repoInfo: info, baseInput, compareInput } })
        await get().refreshCompare()
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err), compare: { ...get().compare, loading: false } })
      }
    },

    setBaseInput(s) {
      set({ compare: { ...get().compare, baseInput: s } })
      if (compareTimer) clearTimeout(compareTimer)
      compareTimer = setTimeout(() => { void get().refreshCompare() }, 300)
    },

    setCompareInput(s) {
      set({ compare: { ...get().compare, compareInput: s } })
      if (compareTimer) clearTimeout(compareTimer)
      compareTimer = setTimeout(() => { void get().refreshCompare() }, 300)
    },

    swapRefs() {
      const { baseInput, compareInput } = get().compare
      set({ compare: { ...get().compare, baseInput: compareInput, compareInput: baseInput } })
      void get().refreshCompare()
    },

    async refreshCompare() {
      const gen = ++compareGen
      const { repo, baseInput, compareInput } = get().compare
      if (!repo || !baseInput || !compareInput) return
      set({ compare: { ...get().compare, loading: true } })
      try {
        const data = await window.api.compareInfo(repo, baseInput, compareInput)
        if (gen !== compareGen) return // superseded by a newer refresh
        set({ compare: { ...get().compare, data, loading: false } })
      } catch (err) {
        if (gen !== compareGen) return
        set({ compare: { ...get().compare, loading: false }, error: err instanceof Error ? err.message : String(err) })
      }
    },

    async startFromCompare() {
      const { repo, baseInput, compareInput } = get().compare
      const agent = get().agent
      if (!repo || !baseInput || !compareInput) return
      try {
        const { sessionId } = await window.api.startSession(repo, baseInput, compareInput, agent)
        const loaded = await window.api.loadSession(sessionId)
        set({
          sessionId, loaded, error: null, screen: 'review',
          repo, branch: loaded.state.branch, base: loaded.state.base,
          viewedAt: loaded.state.viewedAt,
          reviewedSections: new Set(loaded.state.reviewedSections),
          collapsed: new Set<string>(), cur: null,
          agent: loaded.state.agent ?? agent,
          activeChatId: pickActiveChat(loaded.state.chats, null)
        })
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err) })
      }
    },

    async resumeExisting(sessionId) {
      try {
        const loaded = await window.api.loadSession(sessionId)
        set({
          sessionId, loaded, error: null, screen: 'review',
          repo: loaded.state.repo, branch: loaded.state.branch, base: loaded.state.base,
          viewedAt: loaded.state.viewedAt,
          reviewedSections: new Set(loaded.state.reviewedSections),
          collapsed: new Set<string>(), cur: null,
          agent: loaded.state.agent ?? get().agent,
          activeChatId: pickActiveChat(loaded.state.chats, null)
        })
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err) })
      }
    },

    async startFresh(sessionId) {
      await window.api.archiveSession(sessionId)
      await get().startFromCompare()
    },

    /** Apply the corrected pair to the session being retargeted (set when the
     *  user arrived from the ref-missing banner), then resume it — review
     *  state (comments, chat, iterations) is preserved, unlike start-fresh. */
    async applyRetarget() {
      const { retargetSessionId, baseInput, compareInput } = get().compare
      if (retargetSessionId == null) return
      try {
        // invariant: retargetSessionId is only ever seeded (backToCompare) when
        // loaded.refMissing is set, so `loaded` is the session being retargeted
        const pair = get().loaded?.session.pair
        if (!pair || pair.base.symbol !== baseInput) {
          await window.api.retargetSession(retargetSessionId, 'base', baseInput)
        }
        if (!pair || pair.compare.symbol !== compareInput) {
          await window.api.retargetSession(retargetSessionId, 'compare', compareInput)
        }
        await get().resumeExisting(retargetSessionId)
      } catch (err) {
        // e.g. invalid ref, or the corrected pair collides with another live session
        set({ error: err instanceof Error ? err.message : String(err) })
      }
    },

    backToDashboard() {
      if (compareTimer) { clearTimeout(compareTimer); compareTimer = null }
      set({
        screen: 'dashboard', loaded: null, sessionId: null,
        compare: { repo: null, repoInfo: null, baseInput: '', compareInput: '', data: null, loading: false, retargetSessionId: null }
      })
      void get().loadDashboard()
    },

    backToCompare() {
      const loaded = get().loaded
      const repo = loaded?.state.repo ?? get().compare.repo
      if (!repo) { get().backToDashboard(); return }
      const baseSym = loaded?.session.pair.base.symbol ?? get().compare.baseInput
      const compareSym = loaded?.session.pair.compare.symbol ?? get().compare.compareInput
      void get().enterCompare(repo, { base: baseSym, compare: compareSym }, { retargetSessionId: loaded?.refMissing ? get().sessionId : null })
    },

    retarget(_side) {
      // navigate to Compare seeded from the loaded session's symbols; backToCompare
      // sets compare.retargetSessionId, so the start panel shows "Retarget
      // session #N", and that button applies the corrected pair in place via
      // applyRetarget (api.retargetSession + resume — review state preserved).
      get().backToCompare()
    },

    setAgent(a) {
      void window.api.setPref('agent', JSON.stringify(a))
      set({ agent: a })
    },

    async reload() {
      const { sessionId } = get()
      if (sessionId == null) return
      const loaded = await window.api.loadSession(sessionId)
      set({
        loaded,
        viewedAt: loaded.state.viewedAt,
        reviewedSections: new Set(loaded.state.reviewedSections),
        activeChatId: pickActiveChat(loaded.state.chats, get().activeChatId)
      })
    },

    toggleViewed(file, currentlyViewed) {
      const viewedAt = { ...get().viewedAt }
      // unchecking removes the record; checking (or re-checking after drift) stamps the current head
      if (currentlyViewed) delete viewedAt[file]
      else viewedAt[file] = get().loaded?.skeleton.headSha ?? ''
      set({ viewedAt })
      persistUi()
    },

    markReviewed(id) {
      const reviewedSections = new Set(get().reviewedSections)
      reviewedSections.add(id)
      set({ reviewedSections })
      persistUi()
    },

    openSection(id) {
      const reviewedSections = new Set(get().reviewedSections)
      const collapsed = new Set(get().collapsed)
      reviewedSections.delete(id)
      collapsed.delete(id)
      set({ reviewedSections, collapsed, cur: id })
      persistUi()
    },

    setCur(id) {
      if (get().cur !== id) set({ cur: id })
    },

    setFocusTarget(t) {
      set({ focusTarget: t })
    },

    setTweak(key, value) {
      void window.api.setPref(key, JSON.stringify(value))
      set({ [key]: value } as Partial<AppStore>)
    },

    startOp(kind, opId, threadId) {
      set({ gen: { running: true, opId, kind, threadId: threadId ?? null, log: [], error: null } })
    },

    pushOpEvent(ev) {
      const gen = get().gen
      if (!gen.running) return
      set({ gen: { ...gen, log: [...gen.log.slice(-200), ev] } })
    },

    finishOp(error) {
      const gen = get().gen
      set({ gen: { ...gen, running: false, error: error ?? null } })
    },

    setComments(comments) {
      const loaded = get().loaded
      if (!loaded) return
      set({ loaded: { ...loaded, state: { ...loaded.state, comments } } })
    },

    // ── chat ──────────────────────────────────────────────────
    switchChat(id) {
      set({ activeChatId: id })
    },

    openChat(threadId) {
      set(threadId != null ? { chatOpen: true, activeChatId: threadId } : { chatOpen: true })
    },

    closeChat() {
      set({ chatOpen: false })
    },

    async newChat() {
      const { sessionId, loaded, agent } = get()
      if (sessionId == null) return
      const active = activeChat(loaded, get().activeChatId)
      const a = active?.agent ?? loaded?.state.agent ?? agent
      try {
        const chats = await window.api.createChat(sessionId, a)
        setChats(chats)
        set({ activeChatId: chats[chats.length - 1]?.id ?? null })
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err) })
      }
    },

    /** Change the active chat's agent. Empty chat → retarget in place; a chat
     *  that already has messages or a bound session → fork a new chat. */
    async setActiveChatAgent(a) {
      const { sessionId, loaded } = get()
      const active = activeChat(loaded, get().activeChatId)
      if (sessionId == null || !active) return
      const isEmpty = active.messages.length === 0 && !active.engineSessionId
      try {
        if (isEmpty) {
          setChats(await window.api.setChatAgent(active.id, a))
        } else {
          const chats = await window.api.createChat(sessionId, a)
          setChats(chats)
          set({ activeChatId: chats[chats.length - 1]?.id ?? null })
        }
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err) })
      }
    },

    sendChat(text, anchor) {
      const active = activeChat(get().loaded, get().activeChatId)
      const body = text.trim()
      if (!active || !body || get().gen.running) return
      const opId = newOpId()
      get().startOp('chat', opId, active.id)
      void window.api.sendChat(active.id, body, opId, anchor)
    },

    sendBatch(threadId, commentIds, steer) {
      if (get().gen.running) return
      const trimmed = steer?.trim() || undefined
      if (commentIds.length === 0 && !trimmed) return
      const opId = newOpId()
      get().openChat(threadId)            // surface the batch in chat (wf-H)
      get().startOp('chat', opId, threadId)
      void window.api.sendBatch(threadId, commentIds, trimmed, opId)
    },

    async deleteChat(id) {
      const { sessionId } = get()
      if (sessionId == null) return
      try {
        const chats = await window.api.deleteChat(id)
        setChats(chats)
        if (get().activeChatId === id) set({ activeChatId: pickActiveChat(chats, null) })
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err) })
      }
    }
  }
})
