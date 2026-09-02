import { I } from '../kit'
import { STEP, type foldControls } from '../lib/expand'
import type { GapRow } from '../lib/rows'

type Controls = ReturnType<typeof foldControls>

/** A collapsed run of unchanged lines, folded the way GitHub folds them: two step
 *  buttons while more than STEP lines hide — ▲ reveals STEP lines from the run's
 *  BOTTOM edge (walking up toward the change above the fold's lower neighbour), ▼
 *  reveals STEP from its TOP edge — one "expand N" once STEP or fewer remain, and an
 *  inert hairline when the file text could not be read. The label keeps the one
 *  useful half of the old `@@` head: where the run leads ("in render"). */
export function FoldRow({ row, controls, inert, onReveal, onRevealAll }: {
  row: GapRow
  controls: Controls
  /** the text could not be fetched — mark the discontinuity, offer nothing */
  inert?: boolean
  onReveal: (edge: 'top' | 'bottom') => void
  onRevealAll: () => void
}) {
  const count = controls?.count ?? null
  const lines = count != null ? `${count} unchanged line${count === 1 ? '' : 's'}` : 'unchanged lines'
  const text = row.where ? `${lines} ${row.where}` : lines
  const fn = row.fn ? <span className="gap-fn">in {row.fn}</span> : null
  if (inert || !controls) return <div className="expander-row gap-static">{text}{fn}</div>
  if (controls.kind === 'single') {
    return (
      <button className="expander-row" onClick={onRevealAll} aria-label={`Expand ${controls.count} hidden lines`}>
        <I.chevR style={{ width: 10, height: 10, transform: 'rotate(90deg)' }} />
        {`expand ${text}`}
        {fn}
      </button>
    )
  }
  return (
    <div className="expander-row fold-steps">
      <span className="fold-btns">
        {controls.up && (
          <button className="fold-btn" onClick={() => onReveal(FoldRow.edgeFor('up'))} aria-label={`Expand ${STEP} lines up`} title={`Show ${STEP} more lines above the change below`}>
            <I.chevR style={{ width: 10, height: 10, transform: 'rotate(-90deg)' }} />
          </button>
        )}
        {controls.down && (
          <button className="fold-btn" onClick={() => onReveal(FoldRow.edgeFor('down'))} aria-label={`Expand ${STEP} lines down`} title={`Show ${STEP} more lines below the change above`}>
            <I.chevR style={{ width: 10, height: 10, transform: 'rotate(90deg)' }} />
          </button>
        )}
      </span>
      <span className="fold-text">{text}{fn}</span>
    </div>
  )
}

/** Which edge of the run a direction reveals from — pinned by test because it is
 *  the easy thing to get backwards: "up" grows the run's bottom edge upward. */
FoldRow.edgeFor = (dir: 'up' | 'down'): 'top' | 'bottom' => (dir === 'up' ? 'bottom' : 'top')
