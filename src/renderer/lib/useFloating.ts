import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { computePosition, type Align, type Side } from './floating'

export interface FloatingOpts {
  /** preferred side; default 'bottom' */
  side?: Side
  /** cross-axis alignment; default 'start' */
  align?: Align
  /** gap between trigger and overlay; default 6 */
  gap?: number
  /** min distance kept from every viewport edge; default 8 */
  margin?: number
  /** match the overlay's width to the trigger's (e.g. a full-width dropdown) */
  matchWidth?: boolean
}

export interface Floating<A extends HTMLElement, F extends HTMLElement> {
  anchorRef: RefObject<A | null>
  floatingRef: RefObject<F | null>
  /** apply to the floating element; `position:fixed` + measured top/left, hidden
   *  until the first measure so it never flashes at the wrong spot. */
  style: CSSProperties
  /** the side actually used after flipping — drive the arrow direction off this */
  side: Side
  /** force a re-measure (e.g. after async content changes the overlay's size) */
  reposition: () => void
}

/** Position a floating overlay (popover, menu, tooltip) against a trigger so it
 *  always stays on-screen: flips to the opposite side when the preferred one has
 *  no room and clamps the cross-axis to the viewport. Uses `position:fixed` so the
 *  overlay escapes any `overflow:hidden` / scroll-clipping ancestor while staying a
 *  DOM child of its wrapper (so outside-click + focus handling keep working).
 *
 *  Built on the pure `computePosition` core; this hook only wires it to live rects
 *  and keeps it fresh on scroll/resize while `open`. */
export function useFloating<A extends HTMLElement = HTMLElement, F extends HTMLElement = HTMLElement>(
  open: boolean,
  opts: FloatingOpts = {},
): Floating<A, F> {
  const anchorRef = useRef<A | null>(null)
  const floatingRef = useRef<F | null>(null)
  const [pos, setPos] = useState<{ top: number; left: number; side: Side; maxHeight: number; width?: number } | null>(null)

  const { side: prefSide = 'bottom', align = 'start', gap = 6, margin = 8, matchWidth = false } = opts

  const place = useCallback(() => {
    const a = anchorRef.current
    const f = floatingRef.current
    if (!a || !f) return
    const ar = a.getBoundingClientRect()
    const fr = f.getBoundingClientRect()
    const viewport = { width: window.innerWidth, height: window.innerHeight }
    const placed = computePosition({
      anchor: { top: ar.top, left: ar.left, width: ar.width, height: ar.height },
      floating: { width: fr.width, height: fr.height },
      viewport, side: prefSide, align, gap, margin,
    })
    // cap the overlay to the room available on its chosen side so long content
    // scrolls internally instead of running off the bottom/top of the window.
    const avail = placed.side === 'top' ? ar.top - gap - margin
      : placed.side === 'bottom' ? viewport.height - (ar.top + ar.height) - gap - margin
      : viewport.height - 2 * margin
    setPos({
      top: placed.top, left: placed.left, side: placed.side,
      maxHeight: Math.max(96, Math.floor(avail)),
      width: matchWidth ? ar.width : undefined,
    })
  }, [prefSide, align, gap, margin, matchWidth])

  useLayoutEffect(() => {
    if (!open) { setPos(null); return }
    place()
    const onScroll = (): void => place()
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    // re-place when the overlay's own size changes (e.g. async content loads in,
    // or a section expands) so it never drifts out from under the trigger.
    const ro = new ResizeObserver(() => place())
    if (floatingRef.current) ro.observe(floatingRef.current)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
      ro.disconnect()
    }
  }, [open, place])

  const style: CSSProperties = pos
    ? { position: 'fixed', top: pos.top, left: pos.left, maxHeight: pos.maxHeight, ...(pos.width != null ? { width: pos.width } : {}) }
    : { position: 'fixed', top: 0, left: 0, visibility: 'hidden' }

  return { anchorRef, floatingRef, style, side: pos?.side ?? prefSide, reposition: place }
}
