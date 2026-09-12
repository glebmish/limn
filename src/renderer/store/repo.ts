import type { StateCreator } from 'zustand'
import type { LoadedReview } from '../../shared/ipc'
import type { RepoInfo, RepoState, SessionListItem } from '../../shared/types'
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

/** Land on `branch`'s review: its latest live session, else the new-review setup.
 *  Called after checking a branch out from the picker so the action lands somewhere. */
export async function openBranchReview(branch: string): Promise<void> {
  const { repo, repoSessions } = useStore.getState()
  if (!repo) return
  const match = repoSessions.find((s) => !s.archived && s.compareKind === 'branch' && s.compareSymbol === branch)
  if (match) await useStore.getState().resumeExisting(match.id)
  else await useStore.getState().openReview(repo, { compare: branch })
}

/** Post-checkout payoff. If `branch` is the loaded review's compare branch, reload it
 *  (its agent-gating state just changed). Otherwise the user checked out a *different*
 *  branch to work on it — land on that branch's review (skipped mid new-review setup
 *  on the Compare screen, where a jump would discard the in-progress ref pair). */
export async function afterCheckout(branch: string, loaded: LoadedReview | null): Promise<void> {
  const compare = loaded?.session.pair.compare
  if (loaded && compare?.kind === 'branch' && compare.symbol === branch) { await useStore.getState().reload(); return }
  await openBranchReview(branch)
}

/** The repo domain: the active repo + its live git state, the session list, and the
 *  hub. Owns opening a repo (resume-vs-transient), the hub screen, checkout/worktree
 *  payoff, and session archive/restore. */
export interface RepoSlice {
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
  repoInfo: null,
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
      const [info, repoState, repoSessions] = await Promise.all([
        api().openRepo(repoPath),
        api().repoState(repoPath),
        api().listRepoSessions(repoPath)
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
    set({ screen: 'hub', repo, loaded: null, sessionId: null, hubReturn: get().sessionId, error: null, pendingDrift: null, watchStopped: null })
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
