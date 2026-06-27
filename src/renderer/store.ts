import { create } from 'zustand'
import type { CliOpenMsg, DashboardData, LoadedReview, OperationStatus } from '../shared/ipc'
import type { AgentRef, AgentWriteCapability, ApprovalDecision, ChatThread, Comment, CommentAnchor, DriftSummary, EngineEvent, ExecutionMode, FileDiff, RepoInfo, RepoState, Section, SessionListItem, ViewMark } from '../shared/types'
import { defaultAgent } from '../shared/agents'
import { DEFAULT_EXECUTION_MODE } from '../shared/executionMode'
import { dev } from './dev'

/** Sentinel id for a local-only "New chat" draft: an empty composer that isn't
 *  persisted (and so doesn't appear in the picker) until its first message lands. */
export const DRAFT_CHAT_ID = -1
type ChatDraft = Omit<ChatThread, 'id'>

export type Density = 'compact' | 'comfortable' | 'spacious'
export type Guidance = 'minimal' | 'guided' | 'narrated'

/** Fixed presentation settings — baked in, not user-tweakable (formerly the
 *  wireframe Tweaks panel). Typed as the unions so call-site comparisons like
 *  `GUIDANCE === 'narrated'` stay valid. */
export const DENSITY: Density = 'comfortable'
export const GUIDANCE: Guidance = 'guided'
let opCounter = 0
export function newOpId(): string {
  return `op-${Date.now()}-${++opCounter}`
}

/** Whether the review's compare branch is in a state where agent edits can safely
 *  land. `blocked` → branch checked out nowhere (submissions disabled, offer
 *  checkout). `dirtyWarn` → branch active but its worktree is dirty (allowed, warn).
 *  Non-branch compares are inherently review-only and never blocked. */
export function checkoutGate(loaded: LoadedReview | null): { blocked: boolean; dirtyWarn: boolean; writeEnabled: boolean; branch: string | null } {
  const capability = loaded?.writeCapability
  if (!loaded || !capability) return { blocked: false, dirtyWarn: false, writeEnabled: false, branch: null }
  return {
    blocked: capability.reason === 'not-checked-out',
    dirtyWarn: capability.reason === 'dirty',
    writeEnabled: capability.enabled,
    branch: capability.branch
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

/** A file counts as "viewed" once it has a viewed mark AND hasn't changed since.
 *  Two drift signals clear the tick: a commit touched it since viewing (the hunk
 *  carries `sinceViewed`, set per-file by diffSince), or its on-disk content hash
 *  no longer matches the snapshot (an uncommitted edit). */
export function fileViewed(f: FileDiff, viewedAt: Record<string, ViewMark>): boolean {
  const mark = viewedAt[f.path]
  if (!mark) return false
  if (f.hunks.some((h) => h.sinceViewed)) return false
  // compare against the same `?? ''` convention viewMarkFor stamps with, so a file
  // with no content hash (non-branch compare / hashing skipped) doesn't read back
  // as drifted and clear its own tick.
  return mark.hash === (f.fileHash ?? '')
}

/** The viewed snapshot to stamp for `path`: the compare head + the file's current
 *  content hash (from the rendered diff — merged while dirty, else the spine). */
export function viewMarkFor(loaded: LoadedReview | null, path: string): ViewMark {
  const files = loaded ? (loaded.dirty && loaded.merged ? loaded.merged : loaded.skeleton.files) : []
  return { sha: loaded?.skeleton.headSha ?? '', hash: files.find((f) => f.path === path)?.fileHash ?? '' }
}

/** Section completion is derived from its files: a section is viewed when all of
 *  its files are viewed. Returns the tri-state for the section's checkbox. */
export function sectionViewState(files: FileDiff[], viewedAt: Record<string, ViewMark>): 'none' | 'some' | 'all' {
  if (files.length === 0) return 'none'
  const n = files.filter((f) => fileViewed(f, viewedAt)).length
  return n === 0 ? 'none' : n === files.length ? 'all' : 'some'
}

export interface GenState {
  running: boolean
  opId: string | null
  kind: 'review' | 'chat' | null
  /** for chat ops: which thread the streamed tokens belong to */
  threadId: number | null
  log: EngineEvent[]
  error: string | null
  /** epoch ms the op started — drives the live "elapsed" counter. */
  startedAt: number | null
  /** Typed terminal result; null while idle/running. */
  outcome: OperationStatus | null
}

/** Whether a finished operation has the typed cancelled outcome. */
export function genCancelled(gen: GenState): boolean {
  return gen.outcome === 'cancelled'
}

/** A neutral gen state — the effective op for a review that owns no in-flight op. */
const IDLE_GEN: GenState = { running: false, opId: null, kind: null, threadId: null, log: [], error: null, startedAt: null, outcome: null }

/** `gen` is global to the renderer, but an op belongs to the review whose thread it
 *  streams into. Scope it to the loaded review so an op started on a *different*
 *  session can't paint its progress/cancel state onto the one you're viewing.
 *  Returns the real op when it's owned here, otherwise an idle state. */
export function genForLoaded(gen: GenState, loaded: LoadedReview | null): GenState {
  if (gen.threadId != null && loaded?.state.chats?.some((c) => c.id === gen.threadId)) return gen
  return IDLE_GEN
}

/** The active chat thread (or a sensible default) within the loaded review. */
export function activeChat(loaded: LoadedReview | null, activeChatId: number | null, draft?: ChatDraft | null): ChatThread | null {
  if (activeChatId === DRAFT_CHAT_ID && draft) return { id: DRAFT_CHAT_ID, ...draft }
  const chats = loaded?.state.chats ?? []
  return chats.find((c) => c.id === activeChatId) ?? null
}

export function chatsWithDraft(loaded: LoadedReview | null, draft: ChatDraft | null): ChatThread[] {
  const chats = loaded?.state.chats ?? []
  return draft ? [...chats, { id: DRAFT_CHAT_ID, ...draft }] : chats
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
  /** when the hub was opened from a review, the session to jump back to */
  hubReturn: number | null
  activeChatId: number | null
  /** Local-only composer state; never inserted into persisted ChatThread[]. */
  draftChat: ChatDraft | null
  /** whether the chat drawer is open (lifted here so an agent-identity click in
   *  the review can open a specific chat). */
  chatOpen: boolean
  error: string | null

  // dashboard
  dashboard: DashboardData | null
  filter: string
  sel: number

  /** A transient (preview) review is shown but no session row exists yet. Set when
   *  the transient was opened via "New review" so materialize forces a fresh session
   *  even if one already exists for the pair. */
  transientFresh: boolean

  viewedAt: Record<string, ViewMark>
  collapsed: Set<string>
  /** sections force-opened for re-viewing after they were completed (all files
   *  viewed). Lets you re-open a done section without un-viewing its files. */
  expanded: Set<string>
  cur: string | null
  /** the file nearest the top of the viewport — highlighted in the sidebar tree
   *  and kept in sync as you scroll. */
  curFile: string | null
  /** transient: force-render a focus target (a viewed file / done section)
   *  without mutating viewedAt. Set by focusAnchor. */
  focusTarget: { file?: string; sectionId?: string } | null
  /** the branch moved (commits and/or working-tree edits) since this review was
   *  loaded — drives the titlebar fetch pill. Set by the watcher via onRepoChanged;
   *  cleared on reload (the click folds it in). null = up to date with the load. */
  pendingDrift: DriftSummary | null
  /** path of the artifact whose rendered doc view is open (overlay), or null.
   *  Lifted out of Review so the diff's spec/plan badge can open it too. */
  docPath: string | null

  gen: GenState

  boot(): Promise<void>
  applyCliOpen(msg: CliOpenMsg): void
  // dashboard
  loadDashboard(): Promise<void>
  setFilter(s: string): void
  openRepository(): Promise<void>
  /** Refresh live branch/worktree state for the current repo without reloading the review. */
  refreshRepoContext(): Promise<void>
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
  copyReviewFrom(sourceSessionId: number, sourceIteration: number): Promise<void>
  resumeExisting(sessionId: number): Promise<void>
  backToDashboard(): void
  /** Change the loaded review's base ref (review-header base picker). Transient →
   *  rebuild the preview; persisted → open another review for that pair. A session's
   *  base anchor is immutable because generated-review reuse keys off it. */
  setSessionBase(ref: string): Promise<void>
  // review
  setAgent(a: AgentRef): void
  reload(): Promise<void>
  toggleViewed(file: string, currentlyViewed: boolean): void
  /** Bulk-set the viewed mark for a section's files (the section-level checkbox).
   *  Marking viewed also collapses the section (clears its force-open override). */
  setSectionViewed(sectionId: string, paths: string[], viewed: boolean): void
  openSection(id: string): void
  setCur(id: string): void
  setCurFile(file: string | null): void
  setFocusTarget(t: { file?: string; sectionId?: string } | null): void
  /** stash (or clear) the drift the watcher reported for the loaded review. */
  setPendingDrift(d: DriftSummary | null, capability?: AgentWriteCapability): void
  openDoc(path: string): void
  closeDoc(): void
  startOp(kind: 'review' | 'chat', opId: string, threadId?: number): void
  pushOpEvent(ev: EngineEvent): void
  finishOp(status: OperationStatus, error?: string): void
  setComments(comments: Comment[]): void
  // chat
  switchChat(id: number): void
  openChat(threadId?: number): void
  closeChat(): void
  newChat(): Promise<void>
  setActiveChatAgent(a: AgentRef): Promise<void>
  setChatMode(threadId: number, mode: ExecutionMode): Promise<void>
  /** Persist a reviewer's dismissal of a suggest-mark-viewed card. */
  dismissSuggestion(threadId: number, actionId: string): Promise<void>
  /** answer a pending approval for the running op. */
  respondApproval(requestId: string, decision: ApprovalDecision): void
  /** stop the running op (also auto-denies any parked approvals in main). */
  cancelOp(): void
  sendChat(text: string, anchor?: CommentAnchor): void
  /** continue the review thread with a follow-up chat turn (opens the drawer). */
  followUp(text: string): void
  /** the unified batch turn: send comments to a thread's agent (edits+commits code). */
  sendBatch(threadId: number, commentIds: string[], steer?: string, refine?: boolean): void
  deleteChat(id: number): Promise<void>
}

export const useStore = create<AppStore>((set, get) => {
  const persistUi = async (): Promise<void> => {
    const id = await get().materialize()        // first viewed mark mints the session
    if (id == null) return
    const { viewedAt } = get()
    void window.api.saveUiState(id, { viewedAt })
  }

  /** Splice an updated chat-thread list into the loaded review. */
  const setChats = (chats: ChatThread[]): void => {
    const loaded = get().loaded
    if (loaded) set({ loaded: { ...loaded, state: { ...loaded.state, chats } } })
  }

  /** Send a chat turn to an explicit thread id. This is the low-level path used by
   *  both the composer and the review Follow up CTA; it avoids relying on
   *  activeChatId having just been changed by another action. */
  const sendChatToThread = (threadId: number, body: string, anchor?: CommentAnchor): void => {
    const text = body.trim()
    if (!text || get().gen.running) return
    const loaded = get().loaded
    if (loaded) {
      setChats(loaded.state.chats.map((c) => c.id === threadId
        ? { ...c, messages: [...c.messages, { role: 'user' as const, text, at: new Date().toISOString(), ...(anchor ? { anchor } : {}) }] }
        : c))
    }
    const opId = newOpId()
    get().startOp('chat', opId, threadId)
    void window.api.sendChat(threadId, text, opId, anchor)
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

  // in-flight materialize, so concurrent first-writes don't mint duplicate sessions
  let materializing: Promise<number | null> | null = null

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
    hubReturn: null,
    activeChatId: null,
    draftChat: null,
    chatOpen: dev.flow === 'chat',
    error: null,

    dashboard: null,
    filter: '',
    sel: 0,

    transientFresh: false,

    viewedAt: {},
    collapsed: new Set<string>(),
    expanded: new Set<string>(),
    cur: null,
    curFile: null,
    focusTarget: null,
    pendingDrift: null,
    docPath: null,

    gen: { running: false, opId: null, kind: null, threadId: null, log: [], error: null, startedAt: null, outcome: null },

    async boot() {
      try {
        const prefs = await window.api.getPrefs()
        const parse = <T,>(k: string, fallback: T): T => {
          try { return prefs[k] != null ? (JSON.parse(prefs[k]) as T) : fallback } catch { return fallback }
        }
        set({
          agent: parse<AgentRef>('agent', defaultAgent('claude'))
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
      // dev/screenshot: LIMN_OPEN_SESSION auto-resumes a seeded session onto Review
      const openSession = dev.openSession
      if (openSession) await get().resumeExisting(Number(openSession))
      // dev/screenshot: LIMN_OPEN_HUB lands on the repo hub for a given repo path
      const openHub = dev.openHub
      if (openHub) {
        if (dev.showArchived) set({ showArchived: true })
        await get().enterHub(openHub)
      }
    },

    applyCliOpen(msg) {
      if (msg.error) { set({ error: msg.error }); return }
      const repo = msg.repo
      if (!repo) return
      if (msg.hub) { void get().enterHub(repo); return }              // `limn --hub` → session list
      if (msg.fresh) { void get().openReview(repo, { base: msg.baseInput, compare: msg.compareInput }, { fresh: true }); return }
      if (msg.baseInput || msg.compareInput) { void get().openReview(repo, { base: msg.baseInput, compare: msg.compareInput }); return }
      // bare `limn` → behave like opening from the dashboard (resume the latest session
      // on the current branch, else a transient review)
      void get().openRepo(repo)
    },

    async loadDashboard() {
      try {
        const dashboard = await window.api.dashboard()
        set({ dashboard, recents: dashboard.recents, error: null })
        if (dashboard.notices.length > 0) set({ error: dashboard.notices.join(' ') })
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

    async refreshRepoContext() {
      const repo = get().repo
      if (repo) await loadRepoContext(repo)
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
        // land on the latest session for the checked-out branch; if that branch has
        // none, fall back to the repo's most recent session on any branch
        // (repoSessions is updated_at DESC). Only a repo with no sessions at all
        // opens a fresh transient review for the current branch.
        const onBranch = repoState.current !== 'HEAD'
          ? repoSessions.find((s) => s.compareKind === 'branch' && s.compareSymbol === repoState.current)
          : undefined
        const match = onBranch ?? repoSessions[0]
        if (match) { await get().resumeExisting(match.id); return }
        await get().openReview(repoPath)              // none → transient review for the current branch
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err), screen: 'dashboard' })
      }
    },

    async enterHub(repoPath) {
      const repo = repoPath ?? get().repo
      if (!repo) { get().backToDashboard(); return }
      // remember the review we came from so the hub can offer a jump-back
      set({ screen: 'hub', repo, loaded: null, sessionId: null, hubReturn: get().sessionId, error: null, pendingDrift: null })
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
        // resume a live session for the exact resolved pair unless a fresh review was asked for
        if (!opts?.fresh) {
          const match = await window.api.findSession(repoPath, base, compare)
          if (match) { await get().resumeExisting(match.sessionId); return }
        }
        // transient: render the diff with no session row; persists on first write
        const loaded = await window.api.previewReview(repoPath, base, compare, get().agent)
        set({
          screen: 'review', sessionId: null, loaded, repo: repoPath,
          branch: loaded.state.branch, base: loaded.state.base,
          viewedAt: {}, collapsed: new Set<string>(), expanded: new Set<string>(), cur: null, curFile: null,
          activeChatId: null, draftChat: null, transientFresh: opts?.fresh ?? false, error: null, pendingDrift: null
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

    async copyReviewFrom(sourceSessionId, sourceIteration) {
      const sessionId = await get().materialize()
      if (sessionId == null) return
      try {
        const state = await window.api.copyReviewFrom(sourceSessionId, sourceIteration, sessionId)
        const loaded = await window.api.loadSession(sessionId)
        set({
          sessionId,
          loaded,
          branch: loaded.state.branch,
          base: loaded.state.base,
          viewedAt: state.viewedAt,
          activeChatId: pickActiveChat(loaded.state.chats, null),
          error: null,
          transientFresh: false
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
          // reset the (global) gen state so a previous session's running/errored op
          // doesn't bleed its strip or error banner onto the one being opened.
          gen: { running: false, opId: null, kind: null, threadId: null, log: [], error: null, startedAt: null, outcome: null },
          repo: loaded.state.repo, branch: loaded.state.branch, base: loaded.state.base,
          viewedAt: loaded.state.viewedAt,
          collapsed: new Set<string>(), expanded: new Set<string>(), cur: null, curFile: null,
          agent: loaded.state.agent ?? get().agent,
          activeChatId: pickActiveChat(loaded.state.chats, null),
          draftChat: null,
          pendingDrift: null
        })
        void loadRepoContext(loaded.state.repo)
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err) })
      }
    },

    backToDashboard() {
      set({
        screen: 'dashboard', loaded: null, sessionId: null, transientFresh: false,
        repoState: null, repoSessions: [], pendingDrift: null
      })
      void get().loadDashboard()
    },

    async setSessionBase(ref) {
      const r = ref.trim()
      if (!r) return
      const { sessionId, loaded, repo } = get()
      const compare = loaded?.session.pair.compare.symbol
      if (sessionId == null) {
        // transient: rebuild the preview with the new base, keeping the compare side
        if (repo) await get().openReview(repo, { base: r, compare })
        return
      }
      if (repo) await get().openReview(repo, { base: r, compare })
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
      const prevReviews = (get().loaded?.state.chats ?? []).filter((c) => c.kind === 'review')
      const loaded = await window.api.loadSession(sessionId)
      const reviews = loaded.state.chats.filter((c) => c.kind === 'review')
      // a regenerate created a new review session: open the NEW (latest) review so it
      // appears and opens in the chat sidebar. (The "switch to current" banner still
      // shows if you later navigate back to an older session manually.)
      const regeneratedId = reviews.length > prevReviews.length && prevReviews.length > 0
        ? reviews[reviews.length - 1].id
        : null
      set({
        loaded,
        viewedAt: loaded.state.viewedAt,
        activeChatId: regeneratedId ?? pickActiveChat(loaded.state.chats, get().activeChatId),
        pendingDrift: null // the reload folded any drift in; the watcher re-baselines
      })
      void loadRepoContext(loaded.state.repo) // dirty/worktrees may have changed
    },

    toggleViewed(file, currentlyViewed) {
      const viewedAt = { ...get().viewedAt }
      // unchecking removes the record; checking (or re-checking after drift) snapshots
      // the current head AND the file's on-disk content hash, so later commits or
      // uncommitted edits both re-flag it.
      if (currentlyViewed) delete viewedAt[file]
      else viewedAt[file] = viewMarkFor(get().loaded, file)
      set({ viewedAt })
      persistUi()
    },

    setSectionViewed(sectionId, paths, viewed) {
      const viewedAt = { ...get().viewedAt }
      for (const p of paths) {
        if (viewed) viewedAt[p] = viewMarkFor(get().loaded, p)
        else delete viewedAt[p]
      }
      // marking the section viewed collapses it (and, on remount, its files):
      // drop the force-open override so the now-complete section folds away.
      const expanded = new Set(get().expanded)
      if (viewed) expanded.delete(sectionId)
      set({ viewedAt, expanded })
      persistUi()
    },

    openSection(id) {
      // force-open a (possibly completed) section for re-viewing — without
      // touching viewed marks. This is UI-only, so it isn't persisted.
      const expanded = new Set(get().expanded)
      expanded.add(id)
      set({ expanded, cur: id })
    },

    setCur(id) {
      if (get().cur !== id) set({ cur: id })
    },

    setCurFile(file) {
      if (get().curFile !== file) set({ curFile: file })
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
    setPendingDrift(d, capability) {
      const loaded = get().loaded
      set({
        pendingDrift: d,
        ...(loaded && capability ? { loaded: { ...loaded, writeCapability: capability } } : {})
      })
    },

    startOp(kind, opId, threadId) {
      set({ gen: { running: true, opId, kind, threadId: threadId ?? null, log: [], error: null, startedAt: Date.now(), outcome: null } })
    },

    pushOpEvent(ev) {
      const gen = get().gen
      if (!gen.running) return
      set({ gen: { ...gen, log: [...gen.log.slice(-200), ev] } })
    },

    finishOp(status, error) {
      const gen = get().gen
      set({ gen: { ...gen, running: false, outcome: status, error: status === 'failed' ? error ?? 'unknown error' : null } })
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
      if (sessionId == null || !loaded) return
      const active = activeChat(loaded, get().activeChatId, get().draftChat)
      const a = active?.agent ?? loaded.state.agent ?? agent
      // A new chat is a renderer-only draft (id DRAFT_CHAT_ID) — no DB write, so empty
      // chats never persist or pile up. It materializes on its first message (sendChat).
      if (get().draftChat) { set({ activeChatId: DRAFT_CHAT_ID }); return }
      const draft: ChatDraft = {
        kind: 'user', agent: a, messages: [],
        createdAt: new Date().toISOString(), executionMode: DEFAULT_EXECUTION_MODE
      }
      set({ draftChat: draft, activeChatId: DRAFT_CHAT_ID })
    },

    /** Change the active chat's agent. Draft/empty chat → retarget in place (draft
     *  stays local); a chat with messages or a bound session → fork a new chat. */
    async setActiveChatAgent(a) {
      const { sessionId, loaded } = get()
      const active = activeChat(loaded, get().activeChatId, get().draftChat)
      if (sessionId == null || !active) return
      if (active.id === DRAFT_CHAT_ID) {
        set((s) => ({ draftChat: s.draftChat ? { ...s.draftChat, agent: a } : null }))
        return
      }
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

    async dismissSuggestion(threadId, actionId) {
      try {
        setChats(await window.api.dismissSuggestion(threadId, actionId))
      } catch (err) {
        set({ error: err instanceof Error ? err.message : String(err) })
      }
    },

    respondApproval(requestId, decision) {
      const opId = get().gen.opId
      if (opId) void window.api.respondApproval(opId, requestId, decision)
    },

    cancelOp() {
      const gen = get().gen
      if (!gen.opId) return
      void window.api.cancel(gen.opId)
      // Record the typed cancel outcome up front and leave the running strip
      // immediately; the main-process terminal result will confirm it later.
      set({ gen: { ...gen, running: false, outcome: 'cancelled', error: null } })
    },

    sendChat(text, anchor) {
      const body = text.trim()
      if (!body || get().gen.running) return
      const active = activeChat(get().loaded, get().activeChatId, get().draftChat)
      if (!active) return
      void (async () => {
        let targetId = active.id
        // a draft chat persists lazily on its first turn: mint the real thread now,
        // swap the picker/active id to it, then send into THAT id.
        if (active.id === DRAFT_CHAT_ID) {
          const { sessionId } = get()
          if (sessionId == null) return
          try {
            const chats = await window.api.createChat(sessionId, active.agent)
            setChats(chats)
            targetId = chats[chats.length - 1]?.id ?? DRAFT_CHAT_ID
            if (targetId === DRAFT_CHAT_ID) return
            set({ activeChatId: targetId, draftChat: null })
          } catch (err) {
            set({ error: err instanceof Error ? err.message : String(err) })
            return
          }
        }
        sendChatToThread(targetId, body, anchor)
      })()
    },

    /** "Follow up" from the generate panel: continue the review thread (the agent
     *  that authored the review) with a chat turn, opening the drawer so it streams. */
    followUp(text) {
      const body = text.trim()
      if (!body || get().gen.running) return
      const loaded = get().loaded
      if (!loaded) return
      void (async () => {
        const current = get().loaded
        const review = (current?.state.latestIteration?.sessionId
          ? current.state.chats.find((c) => c.kind === 'review' && c.engineSessionId === current.state.latestIteration?.sessionId)
          : undefined)
          ?? [...(current?.state.chats ?? [])].reverse().find((c) => c.kind === 'review')
        let targetId = review?.id
        if (targetId == null) {
          // Older/generated sessions can predate persisted review threads. Create a
          // normal chat with the review agent so Follow up still has somewhere real
          // to send instead of silently doing nothing.
          const sessionId = get().sessionId ?? await get().materialize()
          if (sessionId == null) return
          try {
            const chats = await window.api.createChat(sessionId, loaded.state.agent ?? get().agent)
            setChats(chats)
            targetId = chats[chats.length - 1]?.id
          } catch (err) {
            set({ error: err instanceof Error ? err.message : String(err) })
            return
          }
        }
        if (targetId == null) return
        get().openChat(targetId)
        sendChatToThread(targetId, body)
      })()
    },

    sendBatch(threadId, commentIds, steer, refine) {
      if (get().gen.running) return
      const trimmed = steer?.trim() || undefined
      if (commentIds.length === 0 && !trimmed) return
      const opId = newOpId()
      // sending to the agent (queued comments OR a decision answer) opens the chat
      // so the turn + its tool calls are visible as they run
      get().openChat(threadId)
      get().startOp('chat', opId, threadId)
      void window.api.sendBatch(threadId, commentIds, trimmed, opId, refine)
    },

    async deleteChat(id) {
      const { sessionId } = get()
      if (sessionId == null) return
      if (id === DRAFT_CHAT_ID) {
        const chats = get().loaded?.state.chats ?? []
        set({ draftChat: null, activeChatId: get().activeChatId === id ? pickActiveChat(chats, null) : get().activeChatId })
        return
      }
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
