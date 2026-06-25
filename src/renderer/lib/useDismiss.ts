import { useEffect, useRef, type RefObject } from 'react'

type AnyRef = RefObject<HTMLElement | null>

/** Close an open popover on an outside pointer-down or Escape — the single place
 *  this lives so every dropdown dismisses identically. Both listeners run in the
 *  capture phase so nothing downstream can swallow the event first. A pointer
 *  landing inside ANY of the given refs keeps it open — pass the trigger and the
 *  popover separately (no wrapping element needed, which is what lets a
 *  fixed-positioned popover live anywhere in the tree).
 *
 *  `close` may be a fresh closure each render (e.g. `() => setOpen(false)`); it
 *  and the ref list are read through refs so the listeners only re-bind when
 *  `open` flips. */
export function useDismiss(open: boolean, close: () => void, refs: AnyRef | AnyRef[]): void {
  const cb = useRef(close)
  cb.current = close
  const list = useRef<AnyRef[]>([])
  list.current = Array.isArray(refs) ? refs : [refs]
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent): void => {
      const t = e.target as Node
      if (!list.current.some((r) => r.current?.contains(t))) cb.current()
    }
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') cb.current() }
    document.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])
}
