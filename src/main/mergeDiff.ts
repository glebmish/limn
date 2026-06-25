import type { FileDiff } from '../shared/types.js'

/** Per-line origin attribution for a base→working-tree diff (`merged`), using the
 *  two diffs that share the committed HEAD as a pivot:
 *    - `skeleton` (base→HEAD, committed): its deletions are the base lines removed
 *      by commits — those base line numbers (`old`) mark `merged` dels as committed.
 *    - `volatile` (HEAD→working-tree, dirty): its additions are the working-tree
 *      lines introduced by uncommitted edits — those worktree line numbers (`new`)
 *      mark `merged` adds as uncommitted.
 *  Both joins are exact integer matches within byte-identical files (the base file
 *  is shared with skeleton, the worktree file with volatile), so there is no text
 *  matching and no ambiguity. Anything not matched is committed. Mutates `merged`. */
export function tagOrigins(merged: FileDiff[], skeleton: FileDiff[], volatile: FileDiff[]): void {
  const skByPath = new Map(skeleton.map((f) => [f.path, f]))
  const volByPath = new Map(volatile.map((f) => [f.path, f]))
  for (const file of merged) {
    const committedDel = new Set<number>()
    for (const h of skByPath.get(file.path)?.hunks ?? [])
      for (const l of h.lines) if (l.kind === 'del' && l.old != null) committedDel.add(l.old)
    const uncommittedAdd = new Set<number>()
    for (const h of volByPath.get(file.path)?.hunks ?? [])
      for (const l of h.lines) if (l.kind === 'add' && l.new != null) uncommittedAdd.add(l.new)
    for (const h of file.hunks) {
      for (const l of h.lines) {
        if (l.kind === 'add') l.origin = l.new != null && uncommittedAdd.has(l.new) ? 'uncommitted' : 'committed'
        else if (l.kind === 'del') l.origin = l.old != null && committedDel.has(l.old) ? 'committed' : 'uncommitted'
      }
    }
  }
}
