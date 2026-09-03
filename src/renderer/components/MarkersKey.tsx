import type { SinceBasis } from '../../shared/sinceBasis'

/** The key, one per file at the right end of its caption row (design board 13, K1,
 *  moved off the page header once Unified kept its caption): a "?" affordance that
 *  opens a hover/focus popover listing only the groups this file can draw — the
 *  colours always; the left-edge rails when the file has uncommitted lines or the
 *  review has a checkpoint to drift from; the between-sheets marks while a checkpoint
 *  sheet is out beside the base. Each group says when it applies, so a reader who has
 *  not pulled a sheet still learns what the hatch would mean.
 *
 *  The drift row names its baseline honestly: the server measures "since" from the
 *  approval if there is one, else from the sha the review was GENERATED at
 *  (src/shared/sinceBasis.ts). */
export function MarkersKey({ dirty, since, betweenSheets = false }: {
  /** this file has uncommitted lines — the staged/unstaged rails */
  dirty: boolean
  /** what the drift rail is measured from, or null when the review has no baseline */
  since: SinceBasis | null
  /** a checkpoint sheet is out beside the base — the attribution marks */
  betweenSheets?: boolean
}) {
  return (
    <span className="fh-rails" tabIndex={0} role="button" aria-label="What the diff marks mean">
      <span className="fh-q" aria-hidden="true">?</span>
      <span className="fh-pop" role="tooltip">
        <span className="key-h">Colour</span>
        <span className="rail-row"><span className="key-sw add">+</span><span className="rail-tx"><b>added</b><em>new line on this branch</em></span></span>
        <span className="rail-row"><span className="key-sw del">−</span><span className="rail-tx"><b>removed</b><em>line the branch deletes</em></span></span>
        <span className="rail-row"><span className="key-sw word" /><span className="rail-tx"><b>edited</b><em>the part of the line that changed</em></span></span>
        {(dirty || since) && (
          <span className="key-h">Left rail{dirty && <span className="key-when">this file has uncommitted work</span>}</span>
        )}
        {dirty && (
          <>
            <span className="rail-row"><span className="rail-sw staged" /><span className="rail-tx"><b>staged</b><em>in the index</em></span></span>
            <span className="rail-row"><span className="rail-sw unstaged" /><span className="rail-tx"><b>unstaged</b><em>working-tree edit</em></span></span>
          </>
        )}
        {since && (
          <span className="rail-row"><span className="rail-sw since" /><span className="rail-tx"><b>changed</b>
            <em>{since === 'approved' ? 'since your approval' : 'since the review ran'}</em></span></span>
        )}
        {betweenSheets && (
          <>
            <span className="key-h">Between sheets<span className="key-when">a checkpoint sheet is out beside the base</span></span>
            <span className="rail-row"><span className="rail-sw since" /><span className="rail-tx"><b>since</b><em>current differs from the checkpoint beside it</em></span></span>
            <span className="rail-row"><span className="rail-sw gone" /><span className="rail-tx"><b>gone</b><em>the checkpoint had it, current does not</em></span></span>
          </>
        )}
      </span>
    </span>
  )
}
