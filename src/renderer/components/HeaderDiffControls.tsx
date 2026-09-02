import { useEffect, useRef, useState } from 'react'
import { I } from '../kit'
import { MarkersKey } from './MarkersKey'
import { baselineLabel, type SinceBasis } from '../../shared/sinceBasis'
import type { DiffMode } from '../store'

/** The BULK diff-baseline dropdown (design 07 `fh-dd`) + the marks key. Always renders
 *  the "Full diff" option; the since-baselines appear only when some file has that
 *  slice. Picking one re-syncs every file (and drops per-file overrides) via
 *  `setGlobalDiffMode` — a single file is switched from its own header picker instead.
 *  Shown in both the annotated (page-head) and flat (flat-toolbar) headers. */
export function HeaderDiffControls({ globalMode, anySinceReview, anySinceApproved, anySinceViewed, dirty, sinceBasis, setGlobalDiffMode }: {
  globalMode: DiffMode
  /** some file has a slice since the sha the review was generated at */
  anySinceReview: boolean
  anySinceApproved: boolean
  anySinceViewed: boolean
  dirty: boolean
  /** what the since-baseline actually is here, or null when the review has none */
  sinceBasis: SinceBasis | null
  setGlobalDiffMode: (m: DiffMode) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent): void => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])
  const labelFor = (m: DiffMode): string => baselineLabel(m)
  // oldest checkpoint first, mirroring a file's own picker (baselinesForFile)
  const items: DiffMode[] = [
    'branch',
    ...(anySinceReview ? (['review'] as const) : []),
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
      <MarkersKey dirty={dirty} since={sinceBasis} />
    </div>
  )
}
