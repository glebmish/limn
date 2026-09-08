import type { StateCreator } from 'zustand'
import type { LoadedReview } from '../../shared/ipc'
import type { RepoState, SessionListItem } from '../../shared/types'
import { api } from '../lib/api'
import type { AppStore } from './index'
import { useStore } from './index'

/** Refresh the current repo's live git state + session list (header switchers
 *  + hub read these). Best-effort — failures leave the prior values. */
export async function loadRepoContext(repo: string): Promise<void> {
  try {
    const [repoState, repoSessions] = await Promise.all([
      api().repoState(repo), api().listRepoSessions(repo, useStore.getState().showArchived)
    ])
    useStore.setState({ repoState, repoSessions })
  } catch { /* keep prior context */ }
}

/** State assignment for landing on the repo hub screen — shared by enterHub (after
 *  validating/refreshing its context) and openRepo's hot path, which already holds
 *  this repo's fresh repoState + repoSessions from its own fetch and would
 *  otherwise pay for a second round trip through loadRepoContext for the same
 *  data (finding 80). */
function enterHubScreen(repo: string): void {
  const hubReturn = useStore.getState().sessionId
  useStore.setState({ screen: 'hub', repo, loaded: null, sessionId: null, hubReturn, error: null, pendingDrift: null, watchStopped: null })
}

/** Land on `branch`'s review: its latest live session, else the new-review setup.
 *  Called after checking a branch out from the picker so the action lands somewhere. */
export async function openBranchReview(branch: string): Promise<void> {
  const { repo, repoSessions } = useStore.getState()
  if (!repo) return
  const match = repoSessions.find((s) => !s.archived && s.compareKind === 'branch' && s.compareSymbol === branch)
  if (match) await useStore.getState().resumeExisting(match.id)
  else await useStore.getState().openReview(repo, { compare: branch })
}

/** Post-checkout payoff. If `branch` is the loaded review's compare branch, refresh it
 *  (its write-gating state just changed) — refreshLoaded, NOT reload: a transient
 *  preview has no sessionId, so a bare reload() would no-op and leave the stale
 *  "isn't checked out" gate up. Otherwise the user checked out a *different* branch
 *  to work on it — land on that branch's review (skipped mid new-review setup on the
 *  Compare screen, where a jump would discard the in-progress ref pair). */
export async function afterCheckout(branch: string, loaded: LoadedReview | null): Promise<void> {
  const compare = loaded?.session.pair.compare
  if (loaded && compare?.kind === 'branch' && compare.symbol === branch) { await useStore.getState().refreshLoaded(); return }
  await openBranchReview(branch)
}

/** The repo domain: the active repo + its live git state, the session list, and the
 *  hub. Owns opening a repo (resume-vs-transient), the hub screen, checkout/worktree
 *  payoff, and session archive/restore. */
export interface RepoSlice {
  repo: string | null
  /** live git state for the current repo (branches, current branch, worktrees,
   *  dirtiness) — feeds the hub + review-header switchers. */
  repoState: RepoState | null
  /** all live sessions for the current repo, latest first (hub list + the review
   *  header's session dropdown). Includes archived ones when `showArchived`. */
  repoSessions: SessionListItem[]
  /** hub toggle: also list archived (soft-deleted) sessions. */
  showArchived: boolean
  /** when the hub was opened from a review, the session to jump back to */
  hubReturn: number | null

  /** Refresh live branch/worktree state for the current repo without reloading the review. */
  refreshRepoContext(): Promise<void>
  /** Open a repo: jump into the latest session for the active branch, else the
   *  new-review setup. The entry point from the dashboard. */
  openRepo(repoPath: string): Promise<void>
  /** Show the repo hub (session list + branch/worktree switchers). */
  enterHub(repoPath?: string): Promise<void>
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
}

export const createRepoSlice: StateCreator<AppStore, [], [], RepoSlice> = (set, get) => ({
  repo: null,
  repoState: null,
  repoSessions: [],
  showArchived: false,
  hubReturn: null,

  async refreshRepoContext() {
    const repo = get().repo
    if (repo) await loadRepoContext(repo)
  },

  async openRepo(repoPath) {
    set({ error: null })
    try {
      // openRepo returns the repo's live state, so this is the whole context: no
      // second repoState round trip for the same three git reads. showArchived
      // matches loadRepoContext's own flag, so the hub branch below never needs
      // a second, differently-filtered listRepoSessions call either.
      const [repoState, repoSessions] = await Promise.all([
        api().openRepo(repoPath),
        api().listRepoSessions(repoPath, get().showArchived)
      ])
      set({ repo: repoPath, repoState, repoSessions })
      // a repo with saved sessions lands on the hub (the session list) — resuming
      // one unasked surprises more than it saves. Only a repo with no LIVE
      // sessions opens a fresh transient review for the current branch (showArchived
      // can make repoSessions non-empty with nothing but archived ones — those don't
      // count). This already holds fresh context from the fetch above, so it lands
      // on the hub screen directly rather than through enterHub, which would
      // otherwise re-fetch both via loadRepoContext for the same repo.
      if (repoSessions.some((s) => !s.archived)) { enterHubScreen(repoPath); return }
      await get().openReview(repoPath)
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err), screen: 'dashboard' })
    }
  },

  async enterHub(repoPath) {
    const repo = repoPath ?? get().repo
    if (!repo) { void get().backToDashboard(); return }
    // Any caller that already holds this repo's live state (e.g. jumping to the hub
    // from a review already loaded for it) skips re-validating — a second repoState
    // round trip just to confirm what the store already proved.
    const alreadyProven = get().repo === repo && get().repoState != null
    if (!alreadyProven) {
      // validate before touching the screen — a dead `/hub?repo=` deep link (a repo
      // that's gone, or was never a git repo) must not strand the user on a broken
      // hub. repoState is the cheap check here (no dao.touchRepo write, no bump to
      // the repo's Recent ranking, unlike openRepo) — any rejection means the path
      // isn't usable, so the message is the fixed wording rather than whatever git
      // error text repoState's failure happened to carry.
      try {
        await api().repoState(repo)
      } catch {
        // backToDashboard's loadDashboard() resets `error` — await it before setting
        // the toast so the toast survives (mirrors boot()'s ticket-ordering comment).
        await get().backToDashboard()
        set({ error: `${repo} is not a git repository` })
        return
      }
    }
    // remember the review we came from so the hub can offer a jump-back
    enterHubScreen(repo)
    await loadRepoContext(repo)
  },

  async checkoutInto(branch, worktreePath) {
    const { repo, loaded } = get()
    if (!repo) return
    try {
      const repoState = await api().checkoutInto(repo, worktreePath, branch)
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
      const repoState = await api().addWorktreeFor(repo, branch, name)
      set({ repoState, error: null })
      await afterCheckout(branch, loaded)
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) })
    }
  },

  async deleteSession(id) {
    await api().archiveSession(id)
    const repo = get().repo
    if (repo) set({ repoSessions: await api().listRepoSessions(repo, get().showArchived) })
  },

  async restoreSession(id) {
    await api().unarchiveSession(id)
    const repo = get().repo
    if (repo) set({ repoSessions: await api().listRepoSessions(repo, get().showArchived) })
  },

  async toggleArchived() {
    const showArchived = !get().showArchived
    set({ showArchived })
    const repo = get().repo
    if (repo) set({ repoSessions: await api().listRepoSessions(repo, showArchived) })
  }
})
