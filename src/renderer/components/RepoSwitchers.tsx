import { useEffect, type ReactNode } from 'react'
import { usePopover } from '../lib/usePopover'

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
  const { open, toggle, close, anchorRef, floatingRef, popStyle } = usePopover<HTMLButtonElement, HTMLDivElement>({ side: 'bottom', align: align === 'right' ? 'end' : 'start', defaultOpen })
  // focus the popover on open so keyboard lands here regardless of prior focus
  useEffect(() => { if (open) floatingRef.current?.focus() }, [open, floatingRef])
  return (
    <div className="rsw">
      <button ref={anchorRef} className="rsw-btn" onClick={toggle}>{trigger(open)}</button>
      {open && (
        <div
          ref={floatingRef}
          tabIndex={-1}
          onKeyDown={(e) => { if (e.key === 'Escape') close() }}
          className={'rsw-pop ' + align + (popClass ? ' ' + popClass : '')}
          style={{ outline: 'none', ...popStyle, ...(width ? { width } : {}) }}
        >
          {children(close)}
        </div>
      )}
    </div>
  )
}
