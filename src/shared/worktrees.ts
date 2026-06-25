/** Turn a branch name into a safe default leaf under `.worktrees/`. Branch names
 * commonly contain slashes; worktree names must not be paths. */
export function suggestedWorktreeName(branch: string): string {
  const name = branch.trim().replace(/[\\/]+/g, '-')
  return name && name !== '.' && name !== '..' ? name : 'worktree'
}

/** Validate the user-provided linked-worktree leaf. The main process still resolves
 * the final path under `.worktrees/`; this keeps UI and API callers on the same
 * contract. */
export function assertSafeWorktreeName(name: string): string {
  const leaf = name.trim()
  if (!leaf) throw new Error('Worktree name is required')
  if (leaf === '.' || leaf === '..' || leaf.includes('/') || leaf.includes('\\') || /^[A-Za-z]:/.test(leaf)) {
    throw new Error('Worktree name must be a single folder name under .worktrees')
  }
  return leaf
}
