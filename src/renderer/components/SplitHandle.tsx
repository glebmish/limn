import { useRef, useState, type JSX } from 'react'
import { KEY_STEP } from '../lib/panelWidths'

/** Pure key-to-value-delta helper shared by the keyboard handler and its tests.
 *  Returns the next value for a handled key, or null when the key is not one
 *  of the ones this handle responds to (the caller then lets the event through
 *  for normal browser handling, e.g. Tab). */
export function keyDelta(key: string, shift: boolean, direction: 1 | -1, value: number, min: number, max: number): number | null {
  const step = shift ? KEY_STEP * 4 : KEY_STEP
  switch (key) {
    case 'ArrowRight': return value + direction * step
    case 'ArrowLeft': return value - direction * step
    case 'Home': return min
    case 'End': return max
    default: return null
  }
}

export interface SplitHandleProps {
  label: string                 // aria-label, e.g. "Resize sidebar"
  value: number                 // current width of the controlled panel
  min: number; max: number      // aria range (the panel's spec range)
  /** +1: dragging right grows the panel (panel is LEFT of the handle — the rail);
   *  −1: dragging right shrinks it (panel is RIGHT of the handle — the drawer). */
  direction: 1 | -1
  /** per-move width (already the raw candidate; the parent clamps + stores) */
  onChange(next: number): void
  /** gesture finished (pointerup / key / reset) — the parent persists */
  onCommit(): void
  /** double-click — the parent resets to the default and persists */
  onReset(): void
}

/** The 6px draggable divider between a fixed-width side panel and the main pane.
 *  Presentational only: it reports candidate widths via onChange as the gesture
 *  progresses and lets the parent own clamping, persistence and the CSS var. */
export function SplitHandle({ label, value, min, max, direction, onChange, onCommit, onReset }: SplitHandleProps): JSX.Element {
  const [dragging, setDragging] = useState(false)
  const dragState = useRef<{ startX: number; startValue: number } | null>(null)

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    dragState.current = { startX: e.clientX, startValue: value }
    setDragging(true)
    document.body.classList.add('is-resizing')
  }

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const start = dragState.current
    if (!start) return
    onChange(start.startValue + direction * (e.clientX - start.startX))
  }

  const endDrag = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragState.current) return
    dragState.current = null
    setDragging(false)
    document.body.classList.remove('is-resizing')
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    onCommit()
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const next = keyDelta(e.key, e.shiftKey, direction, value, min, max)
    if (next === null) return
    e.preventDefault()
    onChange(next)
    onCommit()
  }

  return (
    <div
      className={dragging ? 'split-handle is-dragging' : 'split-handle'}
      role="separator"
      aria-orientation="vertical"
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-label={label}
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={handleKeyDown}
      onDoubleClick={onReset}
    />
  )
}
