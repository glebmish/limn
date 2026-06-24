import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useDismiss } from '../lib/useDismiss'

/** A small button + outside-click popover, shared by the repo switchers. */
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
  const popRef = useRef<HTMLDivElement>(null)
  // focus the popover on open so keyboard lands here regardless of prior focus
  useEffect(() => { if (open) popRef.current?.focus() }, [open])
  useDismiss(open, () => setOpen(false), ref)
  return (
    <div className="rsw" ref={ref}>
      <button className="rsw-btn" onClick={() => setOpen((o) => !o)}>{trigger(open)}</button>
      {open && (
        <div
          ref={popRef}
          tabIndex={-1}
          onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false) }}
          className={'rsw-pop ' + align + (popClass ? ' ' + popClass : '')}
          style={{ outline: 'none', ...(width ? { width } : {}) }}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  )
}
