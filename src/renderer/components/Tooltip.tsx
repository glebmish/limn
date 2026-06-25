import { useState, type HTMLAttributes, type ReactNode } from 'react'
import { useFloating } from '../lib/useFloating'
import type { Align, Side } from '../lib/floating'

/** Hover tooltip that positions itself on-screen via the shared floating core:
 *  flips to the opposite side near a viewport edge and clamps so the box never
 *  spills off-screen — replacing the old pure-CSS `top/left` anchoring that could
 *  clip at the window edges. The trigger is a host <span> you style with
 *  `className`; the bubble carries `tipClassName` (its box + arrow visuals) and is
 *  only mounted while hovered. The chosen side is exposed as `data-side` so arrow
 *  CSS can follow a flip. */
export function Tooltip({
  content, tipClassName, children, side = 'top', align = 'center', gap = 9,
  ...rest
}: {
  content: ReactNode
  tipClassName: string
  children: ReactNode
  side?: Side
  align?: Align
  gap?: number
} & Omit<HTMLAttributes<HTMLSpanElement>, 'content'>) {
  const [show, setShow] = useState(false)
  const { anchorRef, floatingRef, style, side: placed } = useFloating<HTMLSpanElement, HTMLSpanElement>(show, { side, align, gap })
  return (
    <span
      {...rest}
      ref={anchorRef}
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
    >
      {children}
      {show && (
        <span ref={floatingRef} className={tipClassName} style={style} data-side={placed}>
          {content}
        </span>
      )}
    </span>
  )
}
