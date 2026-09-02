import { useEffect, useRef, useState } from 'react'
import type { FileDiff } from '../../shared/types'
import { baselineLabel } from '../../shared/sinceBasis'
import { baselinesForFile, type DiffMode } from '../store'

/** Per-file diff baseline, in the file's own (sticky) header — the global switch in
 *  the page head is a bulk default, too far from the file you are actually reading.
 *  Renders NOTHING for a file with only the full diff to show, so a 38-file review
 *  grows one control per file you have viewed, not 38. */
export function FileBaselinePicker({ f, mode, onPick }: {
  f: FileDiff
  mode: DiffMode
  onPick: (mode: DiffMode) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent): void => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const baselines = baselinesForFile(f)
  if (baselines.length < 2) return null
  return (
    <span className={'fb-dd' + (open ? ' open' : '')} ref={ref} onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className="fb-seg"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Diff baseline for ${f.path}`}
        title="Which baseline this file is shown against"
        onClick={() => setOpen((o) => !o)}
        onBlur={(e) => { if (!e.currentTarget.parentElement?.contains(e.relatedTarget as Node)) setOpen(false) }}
      >
        <span className="fb-label">{baselineLabel(mode)}</span>
        <span className="fh-chev">▾</span>
      </button>
      <span className="fb-menu" role="listbox">
        {baselines.map((m) => (
          <button
            type="button"
            key={m}
            role="option"
            aria-selected={mode === m}
            className={'fh-dd-item' + (mode === m ? ' sel' : '')}
            onClick={() => { onPick(m); setOpen(false) }}
          >
            <span className="fh-dd-check">✓</span>{baselineLabel(m)}
          </button>
        ))}
      </span>
    </span>
  )
}
