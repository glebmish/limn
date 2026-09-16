import type { Comment, CommentAnchor } from '../../shared/types'

// The "outside this diff" band (Review.tsx): comments whose diff anchor names a file
// the review does not show at all. A file IN the diff keeps its own per-file footers
// for lines the diff hides (DiffBody's notShown/outdated), so membership — not the
// re-anchor `notInDiff` flag — is the rule here. Dismissed proposals are hidden
// everywhere until restored (board 14 v3), this band included.

type DiffAnchor = Extract<CommentAnchor, { kind: 'diff' }>

export interface OutsideDiffGroup { file: string; comments: Comment[] }

export function outsideDiffGroups(comments: readonly Comment[], knownFiles: ReadonlySet<string>): OutsideDiffGroup[] {
  const byFile = new Map<string, Comment[]>()
  for (const c of comments) {
    if (c.anchor.kind !== 'diff' || c.status === 'dismissed' || knownFiles.has(c.anchor.file)) continue
    const list = byFile.get(c.anchor.file) ?? []
    list.push(c)
    byFile.set(c.anchor.file, list)
  }
  return [...byFile.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([file, list]) => ({ file, comments: list.sort((a, b) => (a.anchor as DiffAnchor).line - (b.anchor as DiffAnchor).line) }))
}

export interface SnippetLine { n: number; text: string; hit: boolean }

/** The seven-ish lines a stamped anchor carries (±CONTEXT_N around the anchor line),
 *  numbered from the real line numbers, with the anchored line(s) marked. Without a
 *  stamp the anchor knows only its own line. */
export function snippetLines(a: DiffAnchor): SnippetLine[] {
  const before = a.context?.before ?? []
  const after = a.context?.after ?? []
  const end = a.endLine ?? a.line
  const lines = [...before, a.lineContent, ...after]
  const first = a.line - before.length
  return lines.map((text, i) => {
    const n = first + i
    return { n, text, hit: n >= a.line && n <= end }
  })
}
