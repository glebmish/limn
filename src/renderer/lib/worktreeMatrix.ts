/** The minimal slice of a git worktree the checkout matrix reasons about. */
export interface WtState { path: string; branch: string | null; primary: boolean; dirty: boolean }

/** What the panel's action zone should offer for a selected branch.
 *  - `settled`     — the branch is already checked out in the chosen target; nothing to do.
 *  - `goto-host`   — the branch lives in another worktree; the only move is to realign there
 *                    (git forbids the same branch in two worktrees).
 *  - `checkout`    — the branch is checked out nowhere; offer to check it out into `target`.
 *                    `dirtyBlocked` flags that the chosen target is dirty (checkout will fail).
 *  - `not-a-branch`— the ref isn't a real branch (commit / HEAD~N); nothing to check out. */
export type Matrix =
  | { mode: 'settled'; host: WtState }
  | { mode: 'goto-host'; host: WtState }
  | { mode: 'checkout'; target: WtState; dirtyBlocked: boolean }
  | { mode: 'not-a-branch' }

/** Decide the action zone from (selected branch, worktrees, chosen target path).
 *  Pure — no git, no React. See `Matrix` for the cases. */
export function checkoutMatrix(branch: string, isBranch: boolean, worktrees: WtState[], targetPath: string): Matrix {
  if (!isBranch) return { mode: 'not-a-branch' }
  const host = worktrees.find((w) => w.branch === branch)
  if (host) return host.path === targetPath ? { mode: 'settled', host } : { mode: 'goto-host', host }
  const target = worktrees.find((w) => w.path === targetPath) ?? worktrees[0]
  return { mode: 'checkout', target, dirtyBlocked: target.dirty }
}
