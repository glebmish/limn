import type { FocusTarget } from '../../shared/types'
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

/** Scroll the review to a target and briefly highlight it. Ensures the target is
 *  rendered first (a collapsed/viewed file or a reviewed section is force-shown via
 *  a transient `focusTarget`, without touching `viewedAt`/`reviewedSections`), then
 *  hands off to `startFocusJump`, which resolves the `data-limn-*` node, scrolls
 *  until the layout around it stops moving, and flashes it. Reused by focus chips. */
export function focusAnchor(target: FocusTarget): void {
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
  startFocusJump(anchor)
}
