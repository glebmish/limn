import { I } from '../kit'

/** Markers-key legend (design 07 `fh-rails`/`fh-pop`): an "i" affordance that opens a
 *  hover/focus popover explaining the per-line left-edge rails — committed (solid grey),
 *  staged (solid amber), unstaged (dotted amber). Replaces the per-file "uncommitted"
 *  chip that used to repeat on every working-tree row. */
export function MarkersKey() {
  return (
    <span className="fh-rails" tabIndex={0} role="button" aria-label="What the diff left-edge markers mean">
      <I.info className="fh-i" />
      <span className="fh-pop" role="tooltip">
        <span className="rail-row"><span className="rail-sw com" /><span className="rail-tx"><b>committed</b><em>landed in a commit</em></span></span>
        <span className="rail-row"><span className="rail-sw staged" /><span className="rail-tx"><b>staged</b><em>in the index</em></span></span>
        <span className="rail-row"><span className="rail-sw unstaged" /><span className="rail-tx"><b>unstaged</b><em>working-tree edit</em></span></span>
      </span>
    </span>
  )
}
