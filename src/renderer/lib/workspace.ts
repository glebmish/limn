import type { SessionListItem, WorktreeInfo } from '../../shared/types'

/** Display name for a worktree: primary → "primary"; linked worktrees are
 *  conventionally `<repoBase>--<branch>`, so strip the shared prefix for a
 *  legible label. */
export function wtName(path: string, primary: boolean, repoBase: string): string {
  if (primary) return 'primary'
  const leaf = path.split('/').pop() ?? path
  return repoBase && leaf.startsWith(repoBase + '--') ? leaf.slice(repoBase.length + 2) : leaf
}

/** Where the compare branch is checked out (git guarantees ≤ 1 worktree).
 *  `detached` ⇒ the branch lives in no worktree → the review is read-only. */
export function branchLocation(
  branch: string, worktrees: WorktreeInfo[]
): { host: WorktreeInfo | null; detached: boolean; dirty: boolean } {
  const host = worktrees.find((w) => w.branch === branch) ?? null
  return { host, detached: !host, dirty: !!host?.dirty }
}

/** Non-archived branch-compare sessions for `branch`, newest first. */
export function reviewsForBranch(sessions: SessionListItem[], branch: string): SessionListItem[] {
  return sessions
    .filter((s) => !s.archived && s.compareKind === 'branch' && s.compareSymbol === branch)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
}
