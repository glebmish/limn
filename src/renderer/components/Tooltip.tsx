import { type HTMLAttributes, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTooltip } from '../lib/useTooltip'
import type { Align, Side } from '../lib/floating'

/** Hover tooltip that positions itself on-screen via the shared floating core:
 *  flips to the opposite side near a viewport edge and clamps so the box never
 *  spills off-screen — replacing the old pure-CSS `top/left` anchoring that could
 *  clip at the window edges. The trigger is a host <span> you style with
 *  `className`; the bubble carries `tipClassName` (its box + arrow visuals) and is
 *  only mounted while hovered, with no browser tooltip delay. The chosen side is
 *  exposed as `data-side` so arrow CSS can follow a flip.
 *
 *  The bubble is PORTALLED to <body>: `position:fixed` is viewport-relative only
 *  while no ancestor establishes a containing block for it, and `.gfile-diff` does
 *  (content-visibility:auto ⇒ paint/layout containment) — which pinned every in-diff
 *  tooltip to the file body's origin and clipped it there. */
export function Tooltip({
  content, tipClassName, children, side = 'top', align = 'center', gap = 9, delay = 0,
  ...rest
}: {
  content: ReactNode
  tipClassName: string
  /** ms the pointer must rest on the trigger before the bubble appears (default 0) */
  delay?: number
  /** optional: a trigger can be a bare styled host (e.g. an invisible hit strip) */
  children?: ReactNode
  side?: Side
  align?: Align
  gap?: number
} & Omit<HTMLAttributes<HTMLSpanElement>, 'content'>) {
  const { show, hoverProps, anchorRef, floatingRef, style, side: placed } = useTooltip<HTMLSpanElement, HTMLSpanElement>({ side, align, gap, delay })
  return (
    <span {...rest} ref={anchorRef} {...hoverProps}>
      {children}
      {show && createPortal(
        <span ref={floatingRef} className={tipClassName} style={style} data-side={placed}>
          {content}
        </span>,
        document.body
      )}
    </span>
  )
}
