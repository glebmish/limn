import { useEffect, useRef, type RefObject } from 'react'

/** Close an open popover on an outside pointer-down or Escape — the single place
 *  this lives so every dropdown dismisses identically. Both listeners run in the
 *  capture phase so nothing downstream can swallow the event first. `ref` wraps
 *  the trigger + popover together; pointers landing inside it keep it open.
 *
 *  `close` may be a fresh closure each render (e.g. `() => setOpen(false)`); it's
 *  read through a ref so the listeners only re-bind when `open` flips. */
export function useDismiss(open: boolean, close: () => void, ref: RefObject<HTMLElement | null>): void {
  const cb = useRef(close)
  cb.current = close
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) cb.current()
    }
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') cb.current() }
    document.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open, ref])
}
