/** Shared overlay-positioning core. Pure math: given the trigger's rect, the
 *  floating element's measured size, and the viewport, return where to place the
 *  floating box so it stays on-screen. Implements the two behaviours every popover
 *  in the app was missing: FLIP (swap to the opposite side when the preferred one
 *  has no room) and SHIFT (clamp the cross-axis so the box never spills past a
 *  viewport edge). Coordinates are viewport-relative, intended for `position:fixed`
 *  so the overlay escapes any `overflow:hidden` / scroll-clipping ancestor.
 *
 *  Kept free of React so it can be unit-tested as plain math; the `useFloating`
 *  hook in ./useFloating wires it to live DOM rects. */

export type Side = 'top' | 'bottom' | 'left' | 'right'
export type Align = 'start' | 'center' | 'end'

export interface Rect { top: number; left: number; width: number; height: number }
export interface Size { width: number; height: number }
export interface Viewport { width: number; height: number }

export interface PlaceOpts {
  /** trigger rect in viewport coordinates (getBoundingClientRect) */
  anchor: Rect
  /** measured size of the floating element */
  floating: Size
  viewport: Viewport
  /** preferred side; default 'bottom' */
  side?: Side
  /** cross-axis alignment relative to the anchor; default 'start' */
  align?: Align
  /** gap between anchor and floating, in px; default 6 */
  gap?: number
  /** minimum distance the floating box keeps from every viewport edge; default 8 */
  margin?: number
}

export interface Placed { left: number; top: number; side: Side }

const OPPOSITE: Record<Side, Side> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' }
const isVertical = (s: Side): boolean => s === 'top' || s === 'bottom'

/** Space between the anchor and the viewport edge on a given side. */
function spaceOn(side: Side, a: Rect, vp: Viewport): number {
  switch (side) {
    case 'top': return a.top
    case 'bottom': return vp.height - (a.top + a.height)
    case 'left': return a.left
    case 'right': return vp.width - (a.left + a.width)
  }
}

/** main-axis coordinate (the edge the floating box is pushed to) for a side */
function mainCoord(side: Side, a: Rect, f: Size, gap: number): number {
  switch (side) {
    case 'top': return a.top - f.height - gap
    case 'bottom': return a.top + a.height + gap
    case 'left': return a.left - f.width - gap
    case 'right': return a.left + a.width + gap
  }
}

/** cross-axis coordinate before clamping, per alignment */
function crossCoord(vertical: boolean, align: Align, a: Rect, f: Size): number {
  const start = vertical ? a.left : a.top
  const extent = vertical ? a.width : a.height
  const size = vertical ? f.width : f.height
  switch (align) {
    case 'start': return start
    case 'center': return start + extent / 2 - size / 2
    case 'end': return start + extent - size
  }
}

/** clamp v so a box of `size` stays within [margin, limit - margin]; if the box is
 *  larger than the available room, pin it to the near margin. */
function clamp(v: number, size: number, limit: number, margin: number): number {
  const max = limit - size - margin
  if (max < margin) return margin
  return Math.max(margin, Math.min(v, max))
}

export function computePosition(o: PlaceOpts): Placed {
  const { anchor, floating, viewport } = o
  const gap = o.gap ?? 6
  const margin = o.margin ?? 8
  const align = o.align ?? 'start'
  let side: Side = o.side ?? 'bottom'

  // FLIP: if the floating box doesn't fit on the preferred side but does on the
  // opposite, swap. The required depth is the box plus its gap and edge margin.
  const need = (isVertical(side) ? floating.height : floating.width) + gap + margin
  if (spaceOn(side, anchor, viewport) < need && spaceOn(OPPOSITE[side], anchor, viewport) >= need) {
    side = OPPOSITE[side]
  }

  const vertical = isVertical(side)
  const main = mainCoord(side, anchor, floating, gap)
  const cross = crossCoord(vertical, align, anchor, floating)

  if (vertical) {
    return {
      side,
      top: main,
      left: clamp(cross, floating.width, viewport.width, margin),
    }
  }
  return {
    side,
    left: main,
    top: clamp(cross, floating.height, viewport.height, margin),
  }
}
