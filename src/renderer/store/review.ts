import type { StateCreator } from 'zustand'
import type { LoadedReview } from '../../shared/ipc'
import type { AgentWriteCapability, Comment, CommentAnchor, DriftSummary } from '../../shared/types'
import { api } from '../lib/api'
import type { AppStore } from './index'
import { useStore } from './index'
import { loadWarningStrip, pickActiveChat } from './derive'
import { loadRepoContext } from './repo'

// in-flight materialize, so concurrent first-writes don't mint duplicate sessions.
// Module-scope single-flight guard: promoted out of the store factory so it survives
// the slice split while keeping its exact set-before-await / clear-in-finally semantics.
let materializing: Promise<number | null> | null = null

// The shared apply step for the comment CRUD actions: swap the loaded review's
// comment list for the persisted one. Slice-internal — promoted to a module fn
// reaching the store via useStore.getState()/setState (the step-4/6 pattern), so it
// is no longer a public store seam. Behaviour is verbatim the old setComments action.
function setComments(comments: Comment[]) {
  const loaded = useStore.getState().loaded
  if (!loaded) return
  useStore.setState({ loaded: { ...loaded, state: { ...loaded.state, comments } } })
}

/** The review-lifecycle domain: the loaded review (transient → materialized), its
 *  ref pair, and the branch-drift pill. Owns opening/resuming/copying a review,
 *  the single-flight materialize that mints a session on first write, and reload. */
export interface ReviewSlice {
  branch: string
  base: string
  loaded: LoadedReview | null
  sessionId: number | null

  /** A transient (preview) review is shown but no session row exists yet. Set when
   *  the transient was opened via "New review" so materialize forces a fresh session
   *  even if one already exists for the pair. */
  transientFresh: boolean

  /** the branch moved (commits and/or working-tree edits) since this review was
   *  loaded — drives the titlebar fetch pill. Set by the watcher via onRepoChanged;
   *  cleared on reload (the click folds it in). null = up to date with the load. */
  pendingDrift: DriftSummary | null

  /** Start a fresh review for the current repo (new-review setup). */
  newReview(): Promise<void>
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
  /** Change the loaded review's base ref (review-header base picker). Transient →
   *  rebuild the preview; persisted → open another review for that pair. A session's
   *  base anchor is immutable because generated-review reuse keys off it. */
  setSessionBase(ref: string): Promise<void>
  // review
  reload(): Promise<void>
  /** stash (or clear) the drift the watcher reported for the loaded review. */
  setPendingDrift(d: DriftSummary | null, capability?: AgentWriteCapability): void
  // comments (comment ownership ruling): this slice owns all comment mutations. Each
  // action mints the session on first write (materialize) then applies the persisted
  // comment list via the slice-internal setComments apply step.
  /** Queue a new user comment against `anchor`; mints the session on first write.
   *  Returns the new comment id, or null if the session couldn't be materialized. */
  addComment(anchor: CommentAnchor, text: string): Promise<string | null>
  editComment(comment: Comment, text: string): Promise<void>
  deleteComment(id: string): Promise<void>
  /** Re-queue a resolved comment (reviewer-authored OR agent hotspot): flips
   *  `status` back to 'queued' and persists it — nothing more. This is the ONLY
   *  path a hotspot comment can take into the user's batch, and it is purely a
   *  status flip: it does NOT send/dispatch anything to an agent (spec Decision
   *  19) — the reviewer still clicks "Send now" separately once queued. */
  requeueComment(comment: Comment): Promise<void>
}

export const createReviewSlice: StateCreator<AppStore, [], [], ReviewSlice> = (set, get) => ({
  branch: '',
  base: '',
  loaded: null,
  sessionId: null,
  transientFresh: false,
  pendingDrift: null,

  async newReview() {
    const repo = get().repo
    if (repo) await get().openReview(repo, undefined, { fresh: true })
  },

  async openReview(repoPath, refs, opts) {
    set({ error: null })
    try {
      // ensure repo context (state + session list). openRepo seeds these for the
      // dashboard path; CLI / direct callers may not have them yet, so fetch when
      // the repo differs or state is missing. openRepo also records it under Recent.
      if (get().repo !== repoPath || !get().repoState) {
        const [info, repoState, repoSessions] = await Promise.all([
          api().openRepo(repoPath), api().repoState(repoPath), api().listRepoSessions(repoPath)
        ])
        set({ repo: repoPath, repoInfo: info, repoState, repoSessions })
      }
      const repoState = get().repoState
      if (!repoState) return
      const base = refs?.base ?? repoState.defaultBase
      const compare = refs?.compare ?? (repoState.current !== 'HEAD' ? repoState.current : repoState.branches[0] ?? '')
      // resume a live session for the exact resolved pair unless a fresh review was asked for
      if (!opts?.fresh) {
        const match = await api().findSession(repoPath, base, compare)
        if (match) { await get().resumeExisting(match.sessionId); return }
      }
      // transient: render the diff with no session row; persists on first write
      const loaded = await api().previewReview(repoPath, base, compare, get().agent)
      set({
        screen: 'review', sessionId: null, loaded, repo: repoPath,
        branch: loaded.state.branch, base: loaded.state.base,
        viewedAt: {}, collapsed: new Set<string>(), expanded: new Set<string>(), cur: null, curFile: null,
        diffMode: 'branch',
        activeChatId: null, draftChat: null, transientFresh: opts?.fresh ?? false, error: loadWarningStrip(loaded), pendingDrift: null, watchStopped: null
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
        const { sessionId } = await api().startSession(repo, pair.base.symbol, pair.compare.symbol, reviewAgent, transientFresh)
        const real = await api().loadSession(sessionId)
        // swap in the persisted shell but KEEP the store's in-memory viewed/reviewed
        // marks — the write that triggered materialize set them just before this.
        // viewedAt lives at the top level (survives the swap); fileExcluded rides on
        // loaded.state, so carry it over explicitly or a first-write exclude is lost.
        const keepExcluded = get().loaded?.state.fileExcluded
        if (keepExcluded && Object.keys(keepExcluded).length > 0) {
          real.state.fileExcluded = { ...real.state.fileExcluded, ...keepExcluded }
        }
        set({ sessionId, loaded: real, transientFresh: false, error: loadWarningStrip(real) })
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
      const state = await api().copyReviewFrom(sourceSessionId, sourceIteration, sessionId)
      const loaded = await api().loadSession(sessionId)
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
      const loaded = await api().loadSession(sessionId)
      set({
        sessionId, loaded, error: loadWarningStrip(loaded), screen: 'review',
        // reset the op map so a previous session's running/errored op doesn't bleed
        // its strip or error banner onto the one being opened. Switching sessions
        // orphans any live stream (main keeps running; its result is dropped by the
        // unknown-opId rule) — acceptable per the concurrent-chat cancellation matrix.
        ops: {},
        repo: loaded.state.repo, branch: loaded.state.branch, base: loaded.state.base,
        viewedAt: loaded.state.viewedAt,
        collapsed: new Set<string>(), expanded: new Set<string>(), cur: null, curFile: null,
        diffMode: 'branch',
        agent: loaded.state.agent ?? get().agent,
        activeChatId: pickActiveChat(loaded.state.chats, null),
        draftChat: null,
        pendingDrift: null,
        watchStopped: null
      })
      void loadRepoContext(loaded.state.repo)
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
    }
  },

  async setSessionBase(ref) {
    const r = ref.trim()
    if (!r) return
    const { loaded, repo } = get()
    const compare = loaded?.session.pair.compare.symbol
    // rebuild the review with the new base, keeping the compare side
    if (repo) await get().openReview(repo, { base: r, compare })
  },

  async reload() {
    const { sessionId } = get()
    if (sessionId == null) return
    const prevReviews = (get().loaded?.state.chats ?? []).filter((c) => c.kind === 'review')
    const loaded = await api().loadSession(sessionId)
    const reviews = loaded.state.chats.filter((c) => c.kind === 'review')
    // a regenerate created a new review session: open the NEW (latest) review so it
    // appears and opens in the chat sidebar. (The "switch to current" banner still
    // shows if you later navigate back to an older session manually.)
    const regeneratedId = reviews.length > prevReviews.length && prevReviews.length > 0
      ? reviews[reviews.length - 1].id
      : null
    set({
      loaded,
      error: loadWarningStrip(loaded),
      viewedAt: loaded.state.viewedAt,
      activeChatId: regeneratedId ?? pickActiveChat(loaded.state.chats, get().activeChatId),
      pendingDrift: null, // the reload folded any drift in; the watcher re-baselines
      watchStopped: null
    })
    void loadRepoContext(loaded.state.repo) // dirty/worktrees may have changed
  },

  setPendingDrift(d, capability) {
    const loaded = get().loaded
    set({
      pendingDrift: d,
      ...(loaded && capability ? { loaded: { ...loaded, writeCapability: capability } } : {})
    })
  },

  async addComment(anchor, text) {
    const sessionId = await get().materialize()  // first comment mints the session
    if (sessionId == null) return null
    const loaded = get().loaded
    const comment: Comment = {
      id: `c-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      anchor,
      author: 'user',
      text,
      status: 'queued',
      replies: [],
      createdAt: new Date().toISOString(),
      iteration: loaded?.state.latestIteration?.n ?? 0
    }
    const state = await api().upsertComment(sessionId, comment)
    setComments(state.comments)
    return comment.id
  },

  async editComment(comment, text) {
    const sessionId = await get().materialize()
    if (sessionId == null) return
    const state = await api().upsertComment(sessionId, { ...comment, text })
    setComments(state.comments)
  },

  async deleteComment(id) {
    const sessionId = await get().materialize()
    if (sessionId == null) return
    const state = await api().deleteComment(sessionId, id)
    setComments(state.comments)
  },

  async requeueComment(comment) {
    const sessionId = await get().materialize()
    if (sessionId == null) return
    const state = await api().upsertComment(sessionId, { ...comment, status: 'queued' })
    setComments(state.comments)
  }
})
