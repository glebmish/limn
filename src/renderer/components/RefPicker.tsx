import { useEffect, useRef, useState } from 'react'
import { ago, shortSha } from '../kit'
import type { RefOptions } from '../../shared/ipc'

export function RefPicker({ value, onChange, repo, relativeTo, label }: {
  value: string
  onChange: (v: string) => void
  repo: string
  relativeTo: string
  label: string
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(value)
  const [opts, setOpts] = useState<RefOptions | null>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const loadedFor = useRef<string>('')

  // lazy-load ref options on first open; reload when repo/relativeTo changes
  useEffect(() => {
    if (!open) return
    const key = `${repo}\0${relativeTo}`
    if (loadedFor.current === key && opts) return
    loadedFor.current = key
    void window.api.refOptions(repo, relativeTo).then(setOpts)
  }, [open, repo, relativeTo]) // eslint-disable-line react-hooks/exhaustive-deps

  // close on outside click / Esc
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const commit = (v: string): void => {
    onChange(v)
    setOpen(false)
  }

  const filter = draft.trim().toLowerCase()
  const branches = (opts?.branches ?? []).filter((b) => b.toLowerCase().includes(filter))
  const commits = (opts?.commits ?? []).filter((c) =>
    c.sha.toLowerCase().includes(filter) || c.subject.toLowerCase().includes(filter))

  return (
    <div className="lr-refpick">
      <button className="lr-refpick-btn" title={label} onClick={() => { setDraft(value); setOpen((o) => !o) }}>
        {value || '—'}
      </button>
      {open && (
        <div className="lr-refpick-pop" ref={popRef}>
          <input
            autoFocus
            value={draft}
            placeholder="branch, SHA, or HEAD~N"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && draft.trim()) commit(draft.trim()) }}
          />
          <div className="lr-refpick-list">
            {branches.length > 0 && <div className="lr-refpick-sec">branches</div>}
            {branches.map((b) => (
              <div key={b} className="lr-refpick-item" onClick={() => commit(b)}>
                <span className="ri-name">{b}</span>
                {opts && b === opts.defaultBase && <span className="ri-tag">(default base)</span>}
              </div>
            ))}
            {commits.length > 0 && <div className="lr-refpick-sec">recent commits</div>}
            {commits.map((c) => (
              <div key={c.sha} className="lr-refpick-item" onClick={() => commit(c.sha)}>
                <span className="ri-name">{shortSha(c.sha)}</span>
                <span className="ri-sub">{c.subject}</span>
                <span className="ri-age">{ago(c.date)}</span>
              </div>
            ))}
            {opts && branches.length === 0 && commits.length === 0 && (
              <div className="dim" style={{ padding: 8, fontSize: 11.5 }}>No matches — press Enter to use "{draft.trim()}".</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
