import { useState, type CSSProperties, type RefObject } from 'react'
import { useFloating, type FloatingOpts } from './useFloating'
import { useDismiss } from './useDismiss'
import type { Side } from './floating'

export interface Popover<A extends HTMLElement, P extends HTMLElement> {
  open: boolean
  setOpen: (v: boolean) => void
  toggle: () => void
  close: () => void
  /** put on the trigger */
  anchorRef: RefObject<A | null>
  /** put on the popover */
  floatingRef: RefObject<P | null>
  /** apply to the popover (position:fixed + measured top/left + max-height) */
  popStyle: CSSProperties
  /** side actually used after flipping — for arrow direction */
  side: Side
}

/** Everything a click-popover needs in one call: open state, on-screen positioning
 *  (useFloating), and outside-click/Escape dismissal (useDismiss watching both the
 *  trigger and the popover, so no wrapper element is required). Adding a new popover
 *  is now: `const p = usePopover(...)`, then spread the three pieces onto the
 *  trigger / popover. */
export function usePopover<A extends HTMLElement = HTMLElement, P extends HTMLElement = HTMLElement>(
  opts: FloatingOpts & { defaultOpen?: boolean; onClose?: () => void } = {},
): Popover<A, P> {
  const { defaultOpen = false, onClose, ...floatingOpts } = opts
  const [open, setOpen] = useState(defaultOpen)
  const { anchorRef, floatingRef, style, side } = useFloating<A, P>(open, floatingOpts)
  const close = (): void => { setOpen(false); onClose?.() }
  useDismiss(open, close, [anchorRef, floatingRef])
  return { open, setOpen, toggle: () => setOpen(!open), close, anchorRef, floatingRef, popStyle: style, side }
}
