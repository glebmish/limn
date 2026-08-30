import type { FileDiff } from '../shared/types.js'

/** A consumable multiset of strings: `take(s)` returns true at most as many times as
 *  `s` was added, so identical deleted lines are matched one-for-one rather than all
 *  collapsing onto a single entry. Backs the best-effort staged/unstaged del match. */
function textBag(files: FileDiff[]): { take: (s: string) => boolean } {
  const counts = new Map<string, number>()
  for (const f of files)
    for (const h of f.hunks)
      for (const l of h.lines)
        if (l.kind === 'del') counts.set(l.text, (counts.get(l.text) ?? 0) + 1)
  return {
    take(s) {
      const n = counts.get(s) ?? 0
      if (n <= 0) return false
      counts.set(s, n - 1)
      return true
    }
  }
}

/** Per-line origin attribution for a base→working-tree diff (`merged`). Three pivots
 *  share line-space joins with it:
 *    - `skeleton` (base→HEAD, committed): its deletions are the base lines removed by
 *      commits — those base line numbers (`old`) mark `merged` dels as committed.
 *    - `volatile` (HEAD→working-tree, dirty): its additions are the working-tree lines
 *      introduced by uncommitted edits — those worktree numbers (`new`) mark `merged`
 *      adds as uncommitted (the rest are committed).
 *    - `unstaged` (index→working-tree): its additions are the worktree lines NOT yet in
 *      the index — a worktree-space `new` join splits an uncommitted add into unstaged
 *      (in this set) vs staged (in the index already).
 *  Added lines join by exact integer in byte-identical files. Deleted lines have no
 *  shared worktree number, so an uncommitted del is split best-effort by text: present
 *  in `unstaged`'s deletions → unstaged, else present in `staged`'s → staged, else
 *  unstaged (the working-tree default). Identical texts are consumed one-for-one.
 *  Untracked files are working-tree-only by definition → every line unstaged. Mutates
 *  `merged`. */
export function tagOrigins(
  merged: FileDiff[], skeleton: FileDiff[], volatile: FileDiff[],
  unstaged: FileDiff[] = [], staged: FileDiff[] = []
): void {
  const skByPath = new Map(skeleton.map((f) => [f.path, f]))
  const volByPath = new Map(volatile.map((f) => [f.path, f]))
  const unstagedByPath = new Map(unstaged.map((f) => [f.path, f]))
  for (const file of merged) {
    const committedDel = new Set<number>()
    for (const h of skByPath.get(file.path)?.hunks ?? [])
      for (const l of h.lines) if (l.kind === 'del' && l.old != null) committedDel.add(l.old)
    const uncommittedAdd = new Set<number>()
    for (const h of volByPath.get(file.path)?.hunks ?? [])
      for (const l of h.lines) if (l.kind === 'add' && l.new != null) uncommittedAdd.add(l.new)
    const unstagedAdd = new Set<number>()
    for (const h of unstagedByPath.get(file.path)?.hunks ?? [])
      for (const l of h.lines) if (l.kind === 'add' && l.new != null) unstagedAdd.add(l.new)
    // best-effort del match: try the unstaged bag first, then the staged bag
    const unstagedDel = textBag(unstagedByPath.get(file.path) ? [unstagedByPath.get(file.path)!] : [])
    const stagedFile = staged.find((f) => f.path === file.path)
    const stagedDel = textBag(stagedFile ? [stagedFile] : [])
    for (const h of file.hunks) {
      for (const l of h.lines) {
        if (l.kind === 'add') {
          if (file.untracked) l.origin = 'unstaged'                                   // never staged — git can't track it yet
          else if (l.new != null && uncommittedAdd.has(l.new))
            l.origin = unstagedAdd.has(l.new) ? 'unstaged' : 'staged'
          else l.origin = 'committed'
        } else if (l.kind === 'del') {
          if (l.old != null && committedDel.has(l.old)) l.origin = 'committed'
          else if (unstagedDel.take(l.text)) l.origin = 'unstaged'
          else if (stagedDel.take(l.text)) l.origin = 'staged'
          else l.origin = 'unstaged'                                                  // working-tree default
        }
      }
    }
  }
}
