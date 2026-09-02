import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { useFloating, type FloatingOpts } from './useFloating'
import type { Side } from './floating'

export interface TooltipCtl<A extends HTMLElement, F extends HTMLElement> {
  show: boolean
  /** spread onto the trigger to reveal the bubble on hover */
  hoverProps: { onMouseEnter: () => void; onMouseLeave: () => void }
  anchorRef: RefObject<A | null>
  floatingRef: RefObject<F | null>
  style: CSSProperties
  side: Side
}

/** Hover-reveal positioning, shared by the <Tooltip> wrapper and call sites that
 *  can't be wrapped (e.g. flex-row buttons) and instead render the bubble as a
 *  child themselves. Flips/clamps to the viewport via useFloating.
 *
 *  `delay` (ms, default 0 = instant) holds the bubble back until the pointer has
 *  settled — for a small target sitting next to another affordance, an instant
 *  tooltip fires every time you pass over it on the way somewhere else. */
export function useTooltip<A extends HTMLElement = HTMLElement, F extends HTMLElement = HTMLElement>(
  opts: FloatingOpts & { delay?: number } = {},
): TooltipCtl<A, F> {
  const { delay = 0, ...floatingOpts } = opts
  const [show, setShow] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancel = (): void => { if (timer.current) { clearTimeout(timer.current); timer.current = null } }
  useEffect(() => cancel, [])
  const { anchorRef, floatingRef, style, side } = useFloating<A, F>(show, floatingOpts)
  return {
    show,
    hoverProps: {
      onMouseEnter: () => {
        cancel()
        if (delay > 0) timer.current = setTimeout(() => setShow(true), delay)
        else setShow(true)
      },
      // leaving cancels a pending reveal as well as hiding a shown one, so a pass-by
      // never resolves into a bubble after the pointer has gone
      onMouseLeave: () => { cancel(); setShow(false) },
    },
    anchorRef, floatingRef, style, side,
  }
}
