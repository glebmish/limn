import type { DiffLine } from '../../shared/types'
import type { SinceBasis } from '../../shared/sinceBasis'
import type { Sheet } from '../../shared/diffStack'

/** What a per-line left-edge rail means, in one sentence — the text the hover shows.
 *  A line can carry both a checkpoint rail and a view mark; the checkpoint wins,
 *  matching the single rail actually drawn (see `.dline.since` in wf.css). Returns
 *  null for a line with no rail at all. */
export function railExplanation(l: DiffLine, basis: SinceBasis): string | null {
  if (l.origin === 'staged') return 'Staged — in the index, not yet committed'
  if (l.origin === 'unstaged') return 'Unstaged — a working-tree edit'
  if (l.since) return basis === 'approved' ? 'Changed since your approval' : 'Changed since the review ran'
  if (l.sinceViewed) return 'Changed since your file view'
  return null
}

/** What a Multi attribution mark means, named after the checkpoint column current is
 *  measured against (design board 13's words). */
export function attributionExplanation(a: 'since' | 'gone', sheet: Sheet): string {
  const cp = sheet === 'approved' ? 'your approval' : sheet === 'review' ? 'the agent review' : sheet === 'viewed' ? 'your file view' : 'the base'
  return a === 'since' ? `Current differs from ${cp}` : `${cp[0].toUpperCase()}${cp.slice(1)} had this — current does not`
}
