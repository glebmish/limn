import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useDismiss } from '../lib/useDismiss'
import { useFloating } from '../lib/useFloating'

/** A small button + outside-click popover, shared by the repo switchers. The
 *  popover positions itself via the shared floating core, so `align` is only the
 *  preferred edge — it flips/clamps to stay on-screen regardless. */
export function Dropdown({ trigger, children, align = 'left', width, defaultOpen = false, popClass }: {
  trigger: (open: boolean) => ReactNode
  children: (close: () => void) => ReactNode
  align?: 'left' | 'right'
  width?: number
  defaultOpen?: boolean
  popClass?: string
}) {
  const [open, setOpen] = useState(defaultOpen)
  const ref = useRef<HTMLDivElement>(null)
  const { anchorRef, floatingRef, style: popStyle } = useFloating<HTMLButtonElement, HTMLDivElement>(open, { side: 'bottom', align: align === 'right' ? 'end' : 'start' })
  // focus the popover on open so keyboard lands here regardless of prior focus
  useEffect(() => { if (open) floatingRef.current?.focus() }, [open, floatingRef])
  useDismiss(open, () => setOpen(false), ref)
  return (
    <div className="rsw" ref={ref}>
      <button ref={anchorRef} className="rsw-btn" onClick={() => setOpen((o) => !o)}>{trigger(open)}</button>
      {open && (
        <div
          ref={floatingRef}
          tabIndex={-1}
          onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false) }}
          className={'rsw-pop ' + align + (popClass ? ' ' + popClass : '')}
          style={{ outline: 'none', ...popStyle, ...(width ? { width } : {}) }}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  )
}
