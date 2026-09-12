import { useEffect, useRef, useState } from 'react'
import { I } from '../kit'
import { MarkersKey } from './MarkersKey'

/** The global diff-baseline dropdown (design 07 `fh-dd`) + the markers key. Always
 *  renders the "Full diff" option; "Since approved"/"Since viewed" appear only when a
 *  file has that baseline. Picking one re-syncs every file via `setGlobalDiffMode`.
 *  Shown in both the annotated (page-head) and flat (flat-toolbar) headers. */
export function HeaderDiffControls({ globalMode, anySinceApproved, anySinceViewed, dirty, setGlobalDiffMode }: {
  globalMode: 'branch' | 'approved' | 'viewed'
  anySinceApproved: boolean
  anySinceViewed: boolean
  dirty: boolean
  setGlobalDiffMode: (m: 'branch' | 'approved' | 'viewed') => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent): void => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])
  const labelFor = (m: 'branch' | 'approved' | 'viewed'): string =>
    m === 'approved' ? 'Since approved' : m === 'viewed' ? 'Since viewed' : 'Full diff'
  const items: ('branch' | 'approved' | 'viewed')[] = [
    'branch',
    ...(anySinceApproved ? (['approved'] as const) : []),
    ...(anySinceViewed ? (['viewed'] as const) : [])
  ]
  return (
    <div className="diffmode-bar">
      <span className={'fh-dd' + (open ? ' open' : '')} ref={ref}>
        <button
          type="button"
          className="fh-seg"
          aria-haspopup="listbox"
          aria-expanded={open}
          title="Choose which baseline the diffs are shown against"
          onClick={() => setOpen((o) => !o)}
          onBlur={(e) => { if (!e.currentTarget.parentElement?.contains(e.relatedTarget as Node)) setOpen(false) }}
        >
          <I.list style={{ width: 13, height: 13 }} />
          <span className="fh-dd-label">{labelFor(globalMode)}</span>
          <span className="fh-chev">▾</span>
        </button>
        <span className="fh-dd-menu" role="listbox">
          {items.map((m) => (
            <button
              type="button"
              key={m}
              role="option"
              aria-selected={globalMode === m}
              className={'fh-dd-item' + (globalMode === m ? ' sel' : '')}
              onClick={() => { setGlobalDiffMode(m); setOpen(false) }}
            >
              <span className="fh-dd-check">✓</span>{labelFor(m)}
            </button>
          ))}
        </span>
      </span>
      {dirty && <MarkersKey />}
    </div>
  )
}
