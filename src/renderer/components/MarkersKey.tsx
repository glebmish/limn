import { I } from '../kit'

/** Markers-key legend (design 07 `fh-rails`/`fh-pop`): an "i" affordance that opens a
 *  hover/focus popover explaining the per-line left-edge rails — committed (solid grey),
 *  staged (solid amber), unstaged (dotted amber), changed-since-you-reviewed (hatched
 *  amber). Replaces the per-file "uncommitted" chip that used to repeat on every
 *  working-tree row.
 *
 *  The `since` row is not optional garnish: with the hunk-level "· changed since
 *  approval" label gone (#11), that rail is the *only* thing telling the reader a line
 *  landed after they approved or viewed — and it used to be drawn in exactly the same
 *  solid amber as `staged`, so a legend without it made the mark ambiguous as well as
 *  unexplained. Its swatch is hatched, matching `.dline.since` (styles/wf.css). */
export function MarkersKey() {
  return (
    <span className="fh-rails" tabIndex={0} role="button" aria-label="What the diff left-edge markers mean">
      <I.info className="fh-i" />
      <span className="fh-pop" role="tooltip">
        <span className="rail-row"><span className="rail-sw com" /><span className="rail-tx"><b>committed</b><em>landed in a commit</em></span></span>
        <span className="rail-row"><span className="rail-sw staged" /><span className="rail-tx"><b>staged</b><em>in the index</em></span></span>
        <span className="rail-row"><span className="rail-sw unstaged" /><span className="rail-tx"><b>unstaged</b><em>working-tree edit</em></span></span>
        <span className="rail-row"><span className="rail-sw since" /><span className="rail-tx"><b>changed</b><em>since you approved or viewed</em></span></span>
      </span>
    </span>
  )
}
