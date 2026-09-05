import type { Comment, CommentAnchor, FocusTarget } from '../../shared/types'
import { effectiveSections, useStore } from '../store'
import { startFocusJump } from './focusScroll'

export { limnSelector } from './focusScroll'

/** The target a jump actually lands on. #18: a diff anchor the re-anchor pass could
 *  not place on the current surface has no line to scroll to — its number is either
 *  stale ('lost', now naming unrelated code) or off this diff — so it degrades to its
 *  file rather than flashing whatever occupies the old line. */
export function jumpTarget(a: FocusTarget): FocusTarget {
  return a.kind === 'diff' && a.stale ? { kind: 'file', file: a.file } : a
}

/** What a jump has to know about a comment: its anchor, plus the two ways a comment
 *  records the very verdict a bare `FocusTarget` records as `stale`. Accepts a live
 *  `Comment` as-is; the fields are optional so a frozen anchor snapshot (no owning
 *  comment left) can be passed too. */
export type CommentJump = { anchor: CommentAnchor; notInDiff?: boolean; status?: Comment['status'] }

/** Why a comment's jump degrades to its file — and the tooltip that says so, in the
 *  same voice as a stale stop's (ActionChips' STALE_TITLE). */
export const COMMENT_JUMP_TITLE = {
  notInDiff: 'This comment is anchored to a line not shown in this diff — jumps to the file instead.',
  outdated: 'The code this comment was written against changed since this comment was made — jumps to the file instead.'
} as const

/** The reason a comment's line number is no longer trustworthy, or null. `notInDiff`
 *  and status 'outdated' are the comment-side spellings of `FocusTarget.stale`. */
export function commentJumpReason(c: CommentJump): keyof typeof COMMENT_JUMP_TITLE | null {
  if (c.anchor.kind !== 'diff') return null
  return c.notInDiff ? 'notInDiff' : c.status === 'outdated' ? 'outdated' : null
}

/** Where a jump from a comment card/row lands: `null` when the anchor names nothing
 *  the review can scroll to, the file alone when the anchor's line is no longer
 *  trustworthy (`commentJumpReason`), otherwise the anchor itself. The comment-side
 *  twin of `jumpTarget` — the ONE place both jump surfaces get this from. */
export function commentJumpTarget(c: CommentJump): FocusTarget | null {
  const a = c.anchor
  if (a.kind === 'diff') return commentJumpReason(c) ? { kind: 'file', file: a.file } : a
  return a.kind === 'summary' || a.kind === 'section' || a.kind === 'file' ? a : null
}

/** Scroll the review to a target and briefly highlight it. Ensures the target is
 *  rendered first (a collapsed/viewed file or a reviewed section is force-shown via
 *  a transient `focusTarget`, without touching `viewedAt`/`reviewedSections`), then
 *  hands off to `startFocusJump`, which resolves the `data-limn-*` node, scrolls
 *  until the layout around it stops moving, and flashes it. Reused by focus chips. */
export function focusAnchor(target: FocusTarget, opts: { quiet?: boolean } = {}): void {
  const anchor = jumpTarget(target)
  const st = useStore.getState()
  // A jump from an open spec/plan must return to the changes view first, or the
  // target diff/section/file node won't exist to scroll to (the jump's retry loop
  // covers the frames the changes list takes to remount).
  if (st.docPath) st.closeDoc()
  // Jumping TO a section opens it imperatively (via openSection), so the arrival
  // expands it but it's still freely collapsible afterward — selection landing on a
  // section must never pin it permanently open. A file/line jump instead force-OPENs
  // the section that holds the file through the TRANSIENT focus target: a collapsed
  // section renders none of its diffs, so the target node would never exist; routing
  // it through focusTarget (not openSection) means only the jumped section opens, and
  // it returns to its natural state once the next jump moves focus on.
  if (anchor.kind === 'section') {
    st.openSection(anchor.sectionId)
    st.setFocusTarget(null)
  } else {
    let secId: string | undefined
    if (anchor.kind === 'file' || anchor.kind === 'diff') {
      secId = effectiveSections(st.loaded).find((s) => s.files.includes(anchor.file))?.id
    }
    st.setFocusTarget(
      anchor.kind === 'file' || anchor.kind === 'diff'
        ? { file: anchor.file, ...(secId ? { sectionId: secId } : {}) }
        : null
    )
  }
  startFocusJump(anchor, opts)
}
