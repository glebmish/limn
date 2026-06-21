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
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])
  return (
    <div className="rsw" ref={ref}>
      <button className="rsw-btn" onClick={() => setOpen((o) => !o)}>{trigger(open)}</button>
      {open && (
        <div className={'rsw-pop ' + align + (popClass ? ' ' + popClass : '')} style={width ? { width } : undefined}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  )
}
