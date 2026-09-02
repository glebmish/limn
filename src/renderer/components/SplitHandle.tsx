import { useEffect, useRef, useState, type JSX } from 'react'
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
  /** the panel's current EFFECTIVE width — what is painted right now, which on a
   *  narrow window can be less than the stored preference. Drags start from it. */
  value: number
  min: number; max: number      // aria range (the panel's spec range)
  /** +1: dragging right grows the panel (panel is LEFT of the handle — the rail);
   *  −1: dragging right shrinks it (panel is RIGHT of the handle — the drawer). */
  direction: 1 | -1
  /** per-move raw candidate width. The parent clamps + applies it (imperatively to
   *  the DOM during a drag, without touching the store) and RETURNS the width it
   *  actually applied — the viewport-guarded effective width, which is what this
   *  handle announces. */
  onChange(next: number): number
  /** gesture finished (last raw candidate of a drag, or the key's candidate). The
   *  parent range-clamps it into a preference and persists it if it changed. Not
   *  called at all for a pointer gesture that never moved — a bare click makes no
   *  claim about the width, and on a guarded viewport the painted width is not the
   *  reviewer's preference. */
  onCommit(next: number): void
  /** double-click — the parent resets to the default and persists */
  onReset(): void
}

/** The 6px draggable divider between a fixed-width side panel and the main pane.
 *  Presentational only: it reports candidate widths via onChange as the gesture
 *  progresses and lets the parent own clamping, persistence and the CSS var. The
 *  parent does not feed a fresh `value` back per move (it writes the CSS var
 *  directly and skips the store until the gesture commits), so this component
 *  tracks its own `liveValue` — the width onChange reported as applied — while
 *  dragging purely so aria-valuenow keeps up; it defers to `value` (the last
 *  painted width) whenever it isn't dragging. */
export function SplitHandle({ label, value, min, max, direction, onChange, onCommit, onReset }: SplitHandleProps): JSX.Element {
  const [dragging, setDragging] = useState(false)
  const [liveValue, setLiveValue] = useState(value)
  // `last` is the most recent raw candidate this gesture produced — null until the
  // pointer actually moves, which is how a bare click is told from a drag.
  const dragState = useRef<{ startX: number; startValue: number; last: number | null } | null>(null)

  // A drag can end without a pointerup ever reaching this handle — the panel it
  // resizes can unmount mid-gesture (closing the chat drawer while dragging its
  // divider, or navigating off the screen). Without this, `is-resizing` would
  // stick on <body> for the rest of the session. Guarded on this instance owning
  // a drag, so unmounting an idle handle can't clear another one's class.
  useEffect(() => () => { if (dragState.current) document.body.classList.remove('is-resizing') }, [])

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    e.currentTarget.focus()
    dragState.current = { startX: e.clientX, startValue: value, last: null }
    setLiveValue(value)
    setDragging(true)
    document.body.classList.add('is-resizing')
  }

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const start = dragState.current
    if (!start) return
    const next = start.startValue + direction * (e.clientX - start.startX)
    start.last = next
    setLiveValue(onChange(next))
  }

  const endDrag = (e: React.PointerEvent<HTMLDivElement>): void => {
    const start = dragState.current
    if (!start) return
    dragState.current = null
    setDragging(false)
    document.body.classList.remove('is-resizing')
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    if (start.last !== null) onCommit(start.last)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const next = keyDelta(e.key, e.shiftKey, direction, value, min, max)
    if (next === null) return
    e.preventDefault()
    onChange(next)
    onCommit(next)
  }

  return (
    <div
      className={dragging ? 'split-handle is-dragging' : 'split-handle'}
      role="separator"
      aria-orientation="vertical"
      aria-valuenow={Math.round(dragging ? liveValue : value)}
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
