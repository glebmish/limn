import { useState, type CSSProperties, type RefObject } from 'react'
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
 *  child themselves. Flips/clamps to the viewport via useFloating. */
export function useTooltip<A extends HTMLElement = HTMLElement, F extends HTMLElement = HTMLElement>(
  opts: FloatingOpts = {},
): TooltipCtl<A, F> {
  const [show, setShow] = useState(false)
  const { anchorRef, floatingRef, style, side } = useFloating<A, F>(show, opts)
  return {
    show,
    hoverProps: { onMouseEnter: () => setShow(true), onMouseLeave: () => setShow(false) },
    anchorRef, floatingRef, style, side,
  }
}
