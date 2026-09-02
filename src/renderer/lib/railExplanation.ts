import type { DiffLine } from '../../shared/types'
import type { SinceBasis } from '../../shared/sinceBasis'

/** What a per-line left-edge rail means, in one sentence — the text the hover shows.
 *  A line can carry both a checkpoint rail and a view mark; the checkpoint wins,
 *  matching the single rail actually drawn (see `.dline.since` in wf.css). Returns
 *  null for a line with no rail at all. */
export function railExplanation(l: DiffLine, basis: SinceBasis): string | null {
  if (l.origin === 'staged') return 'Staged — in the index, not yet committed'
  if (l.origin === 'unstaged') return 'Unstaged — a working-tree edit'
  if (l.since) return basis === 'approved' ? 'Changed since you approved this' : 'Changed since the review ran'
  if (l.sinceViewed) return 'Changed since you viewed this file'
  return null
}
