import { useEffect, useRef, useState, type ReactNode } from 'react'

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
  useEffect(() => {
    if (!open) return
    // focus the popover on open so Escape lands here regardless of prior focus
    popRef.current?.focus()
    const onDown = (e: MouseEvent): void => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    // capture phase on window so nothing can swallow Escape before we see it
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => { document.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey, true) }
  }, [open])
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
