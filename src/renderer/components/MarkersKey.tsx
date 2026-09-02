import type { SinceBasis } from '../../shared/sinceBasis'

/** Markers-key legend (design 07 `fh-rails`/`fh-pop`): a "?" affordance that opens a
 *  hover/focus popover explaining what the diff's marks mean — the per-line left-edge
 *  rails (committed, staged, unstaged, changed-since) and the colours (added, removed,
 *  word-level change).
 *
 *  It used to be gated on `dirty`, which hid it on exactly the reviews that needed it:
 *  a clean branch review still draws the hatched amber drift rail, so the one mark
 *  left on screen was the one with no legend. It now renders always and lists only
 *  what CAN appear here — the working-tree rails when the tree is dirty, the drift
 *  rail when the review has a since-baseline at all.
 *
 *  The drift row names its baseline honestly: the server measures "since" from the
 *  approval if there is one, else from the sha the review was GENERATED at
 *  (src/shared/sinceBasis.ts). Calling that second case "approved" is what made the
 *  rail unreadable — you cannot be "past your approval" on a review you never
 *  approved. */
export function MarkersKey({ dirty, since, multi = false }: {
  /** working tree has uncommitted changes — the staged/unstaged/committed rails */
  dirty: boolean
  /** what the drift rail is measured from, or null when the review has no baseline */
  since: SinceBasis | null
  /** the Multi layout is on — its two attribution marks replace the drift rail there */
  multi?: boolean
}) {
  return (
    <span className="fh-rails" tabIndex={0} role="button" aria-label="What the diff marks mean">
      <span className="fh-q" aria-hidden="true">?</span>
      <span className="fh-pop" role="tooltip">
        {(dirty || since) && <span className="key-h">Left rail</span>}
        {dirty && (
          <>
            <span className="rail-row"><span className="rail-sw com" /><span className="rail-tx"><b>committed</b><em>landed in a commit</em></span></span>
            <span className="rail-row"><span className="rail-sw staged" /><span className="rail-tx"><b>staged</b><em>in the index</em></span></span>
            <span className="rail-row"><span className="rail-sw unstaged" /><span className="rail-tx"><b>unstaged</b><em>working-tree edit</em></span></span>
          </>
        )}
        {since && (
          <span className="rail-row"><span className="rail-sw since" /><span className="rail-tx"><b>changed</b>
            <em>{since === 'approved' ? 'since you approved this' : 'since the review ran'}</em></span></span>
        )}
        {multi && (
          <>
            <span className="key-h">Multi columns</span>
            <span className="rail-row"><span className="rail-sw since" /><span className="rail-tx"><b>since</b><em>now differs from the checkpoint column</em></span></span>
            <span className="rail-row"><span className="rail-sw gone" /><span className="rail-tx"><b>gone</b><em>the checkpoint had it, now does not</em></span></span>
          </>
        )}
        <span className="key-h">Colour</span>
        <span className="rail-row"><span className="key-sw add">+</span><span className="rail-tx"><b>added</b><em>new line on this branch</em></span></span>
        <span className="rail-row"><span className="key-sw del">−</span><span className="rail-tx"><b>removed</b><em>line the branch deletes</em></span></span>
        <span className="rail-row"><span className="key-sw word" /><span className="rail-tx"><b>edited</b><em>the part of the line that changed</em></span></span>
      </span>
    </span>
  )
}
