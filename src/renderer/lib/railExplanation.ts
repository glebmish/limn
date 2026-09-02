import type { DiffLine } from '../../shared/types'
import type { SinceBasis } from '../../shared/sinceBasis'
import type { DiffMode } from '../store/derive'

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

/** What a Multi attribution mark means, named after the checkpoint the middle column
 *  shows. `since` reads exactly like the drift rail's "changed since" sentence for
 *  the approval, so the two never disagree about the same fact. */
export function attributionExplanation(a: 'since' | 'gone', mode: DiffMode): string {
  const cp = mode === 'approved' ? 'you approved this' : mode === 'review' ? 'the review ran' : 'you viewed this file'
  return a === 'since' ? `Changed since ${cp}` : `Was here when ${cp} — gone now`
}
