import { create } from 'zustand'
import type { CliOpenMsg, DashboardData, LoadedReview } from '../shared/ipc'
import type { AgentRef, ApprovalDecision, ChatThread, Comment, CommentAnchor, EngineEvent, EngineId, ExecutionMode, FileDiff, PinNode, RepoInfo, RepoState, RepoStatus, Section, SessionListItem } from '../shared/types'
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

/** Whether the review's compare branch is in a state where agent edits can safely
 *  land. `blocked` → branch checked out nowhere (submissions disabled, offer
 *  checkout). `dirtyWarn` → branch active but its worktree is dirty (allowed, warn).
 *  Non-branch compares are inherently review-only and never blocked. */
export function checkoutGate(loaded: LoadedReview | null): { blocked: boolean; dirtyWarn: boolean; branch: string | null } {
  const compare = loaded?.session.pair.compare
  if (!loaded || compare?.kind !== 'branch') return { blocked: false, dirtyWarn: false, branch: null }
  return {
    blocked: !loaded.compareCheckedOut,
    dirtyWarn: loaded.compareCheckedOut && loaded.dirty,
    branch: compare.symbol
  }
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
  screen: 'dashboard' | 'hub' | 'review'
  recents: string[]
  repo: string | null
  repoInfo: RepoInfo | null
  /** live git state for the current repo (branches, current branch, worktrees,
   *  dirtiness) — feeds the hub + review-header switchers. */
  repoState: RepoState | null
  /** all live sessions for the current repo, latest first (hub list + the review
   *  header's session dropdown). Includes archived ones when `showArchived`. */
  repoSessions: SessionListItem[]
  /** hub toggle: also list archived (soft-deleted) sessions. */
  showArchived: boolean
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

  /** A transient (preview) review is shown but no session row exists yet. Set when
   *  the transient was opened via "New review" so materialize forces a fresh session
   *  even if one already exists for the pair. */
  transientFresh: boolean

  viewedAt: Record<string, string>
  reviewedSections: Set<string>
  collapsed: Set<string>
  cur: string | null
  /** transient: force-render a focus target (a viewed file / reviewed section)
   *  without mutating viewedAt/reviewedSections. Set by focusAnchor. */
  focusTarget: { file?: string; sectionId?: string } | null
  /** path of the artifact whose rendered doc view is open (overlay), or null.
   *  Lifted out of Review so the diff's spec/plan badge can open it too. */
  docPath: string | null

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
  // repo (source of truth)
  /** Open a repo: jump into the latest session for the active branch, else the
   *  new-review setup. The entry point from the dashboard. */
  openRepo(repoPath: string): Promise<void>
  /** Show the repo hub (session list + branch/worktree switchers). */
  enterHub(repoPath?: string): Promise<void>
  /** Start a fresh review for the current repo (new-review setup). */
  newReview(): Promise<void>
  /** Check out `branch` into a worktree (primary or linked) — refused on a dirty
   *  worktree. Reloads the review when `branch` is its compare branch so the
   *  agent-gating state updates. */
  checkoutInto(branch: string, worktreePath: string): Promise<void>
  /** Give `branch` a new linked worktree at `.worktrees/<name>`, then reload if it's
   *  the loaded review's compare branch. */
  addWorktreeFor(branch: string, name: string): Promise<void>
  /** Archive a session and refresh the hub list. */
  deleteSession(id: number): Promise<void>
  /** Restore an archived session and refresh the hub list. */
  restoreSession(id: number): Promise<void>
  /** Toggle whether the hub lists archived sessions. */
  toggleArchived(): Promise<void>
  // review entry
  /** Open the repo's review for a ref pair as the default entry. Resumes a live
   *  session for the exact pair (unless `fresh`), else shows a transient review (no
   *  DB row) that persists on first write. */
  openReview(repo: string, refs?: { base?: string; compare?: string }, opts?: { fresh?: boolean }): Promise<void>
  /** Persist the transient review (create/reuse its session) and return the new id.
   *  Idempotent: returns the existing id when already persisted; null on failure. */
  materialize(): Promise<number | null>
  resumeExisting(sessionId: number): Promise<void>
  backToDashboard(): void
  /** Change the loaded review's base ref (review-header base picker). Transient →
   *  rebuild the preview; persisted → retarget the session in place. */
  setSessionBase(ref: string): Promise<void>
  // review
  setAgent(a: AgentRef): void
  reload(): Promise<void>
  toggleViewed(file: string, currentlyViewed: boolean): void
  markReviewed(id: string): void
  openSection(id: string): void
  setCur(id: string): void
  setFocusTarget(t: { file?: string; sectionId?: string } | null): void
  openDoc(path: string): void
  closeDoc(): void
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
  setChatMode(threadId: number, mode: ExecutionMode): Promise<void>
  /** answer a pending approval for the running op. */
  respondApproval(requestId: string, decision: ApprovalDecision): void
  /** stop the running op (also auto-denies any parked approvals in main). */
  cancelOp(): void
  sendChat(text: string, anchor?: CommentAnchor): void
  /** the unified batch turn: send comments to a thread's agent (edits+commits code). */
  sendBatch(threadId: number, commentIds: string[], steer?: string): void
  deleteChat(id: number): Promise<void>
}

export const useStore = create<AppStore>((set, get) => {
  const persistUi = async (): Promise<void> => {
    const id = await get().materialize()        // first viewed/reviewed mark mints the session
    if (id == null) return
    const { viewedAt, reviewedSections } = get()
    void window.api.saveUiState(id, { viewedAt, reviewedSections: [...reviewedSections] })
  }

  /** Splice an updated chat-thread list into the loaded review. */
  const setChats = (chats: ChatThread[]): void => {
    const loaded = get().loaded
    if (loaded) set({ loaded: { ...loaded, state: { ...loaded.state, chats } } })
  }

  /** Land on `branch`'s review: its latest live session, else the new-review setup.
   *  Called after checking a branch out from the picker so the action lands somewhere. */
  const openBranchReview = async (branch: string): Promise<void> => {
    const { repo, repoSessions } = get()
    if (!repo) return
    const match = repoSessions.find((s) => !s.archived && s.compareKind === 'branch' && s.compareSymbol === branch)
    if (match) await get().resumeExisting(match.id)
    else await get().openReview(repo, { compare: branch })
  }

  /** Post-checkout payoff. If `branch` is the loaded review's compare branch, reload it
   *  (its agent-gating state just changed). Otherwise the user checked out a *different*
   *  branch to work on it — land on that branch's review (skipped mid new-review setup
   *  on the Compare screen, where a jump would discard the in-progress ref pair). */
  const afterCheckout = async (branch: string, loaded: LoadedReview | null): Promise<void> => {
    const compare = loaded?.session.pair.compare
    if (loaded && compare?.kind === 'branch' && compare.symbol === branch) { await get().reload(); return }
    await openBranchReview(branch)
  }

  let rescanRunning = false
  // in-flight materialize, so concurrent first-writes don't mint duplicate sessions
  let materializing: Promise<number | null> | null = null

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

  /** Refresh the current repo's live git state + session list (header switchers
   *  + hub read these). Best-effort — failures leave the prior values. */
  const loadRepoContext = async (repo: string): Promise<void> => {
    try {
      const [repoState, repoSessions] = await Promise.all([
        window.api.repoState(repo), window.api.listRepoSessions(repo, get().showArchived)
      ])
      set({ repoState, repoSessions })
    } catch { /* keep prior context */ }
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
    repoState: null,
    repoSessions: [],
    showArchived: false,
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

    transientFresh: false,

    viewedAt: {},
    reviewedSections: new Set<string>(),
    collapsed: new Set<string>(),
    cur: null,
    focusTarget: null,
    docPath: null,

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
      // dev/screenshot: LR_OPEN_HUB lands on the repo hub for a given repo path
      const openHub = window.lrDev?.openHub
      if (openHub) {
        if (window.lrDev?.showArchived) set({ showArchived: true })
        await get().enterHub(openHub)
      }
    },

    applyCliOpen(msg) {
      if (msg.error) { set({ error: msg.error }); return }
      const repo = msg.repo
      if (!repo) return
      if (msg.hub) { void get().enterHub(repo); return }              // `lr --hub` → session list
      if (msg.fresh) { void get().openReview(repo, { base: msg.baseInput, compare: msg.compareInput }, { fresh: true }); return }
      if (msg.baseInput || msg.compareInput) { void get().openReview(repo, { base: msg.baseInput, compare: msg.compareInput }); return }
      // bare `lr` → behave like opening from the dashboard (resume the latest session
      // on the current branch, else a transient review)
      void get().openRepo(repo)
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
      // escape hatch: open a one-off repo without pinning; openRepo records it, so it
      // shows up under Recent afterwards
      const dir = await window.api.pickRepo()
      if (dir) await get().openRepo(dir)
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

    async openRepo(repoPath) {
      set({ error: null })
      try {
        const [info, repoState, repoSessions] = await Promise.all([
          window.api.openRepo(repoPath),
          window.api.repoState(repoPath),
          window.api.listRepoSessions(repoPath)
        ])
        set({ repo: repoPath, repoInfo: info, repoState, repoSessions })
        // jump into the latest session reviewing the active (checked-out) branch
        const match = repoState.current !== 'HEAD'
          ? repoSessions.find((s) => s.compareKind === 'branch' && s.compareSymbol === repoState.current)
          : undefined
        if (match) { await get().resumeExisting(match.id); return }
        await get().openReview(repoPath)              // none → transient review for the current branch
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err), screen: 'dashboard' })
      }
    },

    async enterHub(repoPath) {
      const repo = repoPath ?? get().repo
      if (!repo) { get().backToDashboard(); return }
      set({ screen: 'hub', repo, loaded: null, sessionId: null, error: null })
      await loadRepoContext(repo)
    },

    async newReview() {
      const repo = get().repo
      if (repo) await get().openReview(repo, undefined, { fresh: true })
    },

    async checkoutInto(branch, worktreePath) {
      const { repo, loaded } = get()
      if (!repo) return
      try {
        const repoState = await window.api.checkoutInto(repo, worktreePath, branch)
        set({ repoState, error: null })
        await afterCheckout(branch, loaded)
      } catch (err) {
        // dirty-worktree block ("commit or stash first") + git's own errors surface here
        set({ error: err instanceof Error ? err.message : String(err) })
      }
    },

    async addWorktreeFor(branch, name) {
      const { repo, loaded } = get()
      if (!repo) return
      try {
        const repoState = await window.api.addWorktreeFor(repo, branch, name)
        set({ repoState, error: null })
        await afterCheckout(branch, loaded)
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err) })
      }
    },

    async deleteSession(id) {
      await window.api.archiveSession(id)
      const repo = get().repo
      if (repo) set({ repoSessions: await window.api.listRepoSessions(repo, get().showArchived) })
    },

    async restoreSession(id) {
      await window.api.unarchiveSession(id)
      const repo = get().repo
      if (repo) set({ repoSessions: await window.api.listRepoSessions(repo, get().showArchived) })
    },

    async toggleArchived() {
      const showArchived = !get().showArchived
      set({ showArchived })
      const repo = get().repo
      if (repo) set({ repoSessions: await window.api.listRepoSessions(repo, showArchived) })
    },

    async openReview(repoPath, refs, opts) {
      set({ error: null })
      try {
        // ensure repo context (state + session list). openRepo seeds these for the
        // dashboard path; CLI / direct callers may not have them yet, so fetch when
        // the repo differs or state is missing. openRepo also records it under Recent.
        if (get().repo !== repoPath || !get().repoState) {
          const [info, repoState, repoSessions] = await Promise.all([
            window.api.openRepo(repoPath), window.api.repoState(repoPath), window.api.listRepoSessions(repoPath)
          ])
          set({ repo: repoPath, repoInfo: info, repoState, repoSessions })
        }
        const repoState = get().repoState
        if (!repoState) return
        const base = refs?.base ?? repoState.defaultBase
        const compare = refs?.compare ?? (repoState.current !== 'HEAD' ? repoState.current : repoState.branches[0] ?? '')
        // resume a live session for the exact pair unless a fresh review was asked for
        if (!opts?.fresh) {
          const match = get().repoSessions.find(
            (s) => !s.archived && s.compareKind === 'branch' && s.compareSymbol === compare && s.baseSymbol === base
          )
          if (match) { await get().resumeExisting(match.id); return }
        }
        // transient: render the diff with no session row; persists on first write
        const loaded = await window.api.previewReview(repoPath, base, compare, get().agent)
        set({
          screen: 'review', sessionId: null, loaded, repo: repoPath,
          branch: loaded.state.branch, base: loaded.state.base,
          viewedAt: {}, reviewedSections: new Set<string>(), collapsed: new Set<string>(), cur: null,
          activeChatId: null, transientFresh: opts?.fresh ?? false, error: null
        })
        void loadRepoContext(repoPath)
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err) })
      }
    },

    async materialize() {
      const existing = get().sessionId
      if (existing != null) return existing
      if (materializing) return materializing
      const { repo, loaded, agent, transientFresh } = get()
      if (!repo || !loaded) return null
      const pair = loaded.session.pair
      const reviewAgent = loaded.session.agent ?? agent
      materializing = (async () => {
        try {
          // startSession (non-fresh) reuses an existing pair-session, so this never
          // duplicates; `transientFresh` forces a brand-new one for "New review".
          const { sessionId } = await window.api.startSession(repo, pair.base.symbol, pair.compare.symbol, reviewAgent, transientFresh)
          const real = await window.api.loadSession(sessionId)
          // swap in the persisted shell but KEEP the store's in-memory viewed/reviewed
          // marks — the write that triggered materialize set them just before this.
          set({ sessionId, loaded: real, transientFresh: false })
          void loadRepoContext(repo)
          return sessionId
        } catch (err) {
          set({ error: err instanceof Error ? err.message : String(err) })
          return null
        } finally {
          materializing = null
        }
      })()
      return materializing
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
        void loadRepoContext(loaded.state.repo)
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err) })
      }
    },

    backToDashboard() {
      set({
        screen: 'dashboard', loaded: null, sessionId: null, transientFresh: false,
        repoState: null, repoSessions: []
      })
      void get().loadDashboard()
    },

    async setSessionBase(ref) {
      const r = ref.trim()
      if (!r) return
      const { sessionId, loaded, repo } = get()
      if (sessionId == null) {
        // transient: rebuild the preview with the new base, keeping the compare side
        const compare = loaded?.session.pair.compare.symbol
        if (repo) await get().openReview(repo, { base: r, compare })
        return
      }
      try {
        await window.api.retargetSession(sessionId, 'base', r)
        await get().reload()
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err) })
      }
    },

    setAgent(a) {
      void window.api.setPref('agent', JSON.stringify(a))
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
      void loadRepoContext(loaded.state.repo) // dirty/worktrees may have changed
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

    openDoc(path) {
      set({ docPath: path })
    },
    closeDoc() {
      set({ docPath: null })
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

    async setChatMode(threadId, mode) {
      try {
        setChats(await window.api.setChatMode(threadId, mode))
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err) })
      }
    },

    respondApproval(requestId, decision) {
      const opId = get().gen.opId
      if (opId) void window.api.respondApproval(opId, requestId, decision)
    },

    cancelOp() {
      const opId = get().gen.opId
      if (opId) void window.api.cancel(opId)
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
