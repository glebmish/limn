import { useEffect, useRef, useState } from 'react'
import { I, ago, shortSha } from '../kit'
import type { CommitInfo } from '../../shared/types'

export function RefPicker({ value, onChange, repo, relativeTo, label, prominent = false }: {
  value: string
  onChange: (v: string) => void
  repo: string
  relativeTo: string
  label: string
  /** Compare side: render the trigger as a bold chip with a branch icon. Base
   *  side (default) stays the quiet text button. */
  prominent?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(value)
  const [branches, setBranches] = useState<string[]>([])
  const [defaultBase, setDefaultBase] = useState('')
  const [commits, setCommits] = useState<CommitInfo[] | null>(null)
  // expand the branch list past the live text filter — when the input names a
  // branch the filtered list collapses to one, so this reveals the rest to switch.
  const [showAllBranches, setShowAllBranches] = useState(false)
  const popRef = useRef<HTMLDivElement>(null)
  const loadedFor = useRef<string>('')

  // The branch the input currently names (if any). When set, the commit list is
  // scoped to *that* branch so you can pick any of its commits — not just its tip.
  const trimmed = draft.trim()
  const matchedBranch = branches.find((b) => b.toLowerCase() === trimmed.toLowerCase())
  const scope = matchedBranch ?? relativeTo

  // lazy-load ref options on first open; reload commits when repo/scope changes
  useEffect(() => {
    if (!open) return
    const key = `${repo}\0${scope}`
    if (loadedFor.current === key) return
    loadedFor.current = key
    setCommits(null) // drop stale commits immediately; the list shows fresh data only
    let ignore = false
    void window.api.refOptions(repo, scope).then((r) => {
      if (ignore) return
      setBranches(r.branches)
      setDefaultBase(r.defaultBase)
      setCommits(r.commits)
    })
    return () => { ignore = true }
  }, [open, repo, scope]) // eslint-disable-line react-hooks/exhaustive-deps

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

  const filter = trimmed.toLowerCase()
  const filteredBranches = branches.filter((b) => b.toLowerCase().includes(filter))
  // expanded → every branch (so you can switch away from a name-matched one);
  // collapsed → the live text filter.
  const branchList = showAllBranches ? branches : filteredBranches
  const hiddenBranches = branches.length - filteredBranches.length
  // when the input names a branch, show all of its commits; otherwise treat the
  // text as a SHA/subject search across the scoped commit list.
  const commitList = (commits ?? []).filter((c) =>
    !!matchedBranch || c.sha.toLowerCase().includes(filter) || c.subject.toLowerCase().includes(filter))

  return (
    <div className="lr-refpick">
      <button className={'lr-refpick-btn' + (prominent ? ' lr-refpick-cmp' : '')} title={value ? `${label}: ${value}` : label} onClick={() => { setDraft(value); setShowAllBranches(false); setOpen((o) => !o) }}>
        {prominent && <I.branch style={{ width: 12, height: 12, color: 'var(--accent)' }} />}
        <span className="rp-val">{value || '—'}</span>
        {prominent && <I.chevD style={{ width: 11, height: 11, color: 'var(--muted)' }} />}
      </button>
      {open && (
        <div className="lr-refpick-pop" ref={popRef}>
          <input
            autoFocus
            value={draft}
            placeholder="branch, SHA, or HEAD~N"
            onChange={(e) => { setDraft(e.target.value); setShowAllBranches(false) }}
            onKeyDown={(e) => { if (e.key === 'Enter' && draft.trim()) commit(draft.trim()) }}
          />
          <div className="lr-refpick-list">
            {branches.length > 0 && (
              <button type="button" className="lr-refpick-sec lr-refpick-sec-btn"
                onClick={() => setShowAllBranches((v) => !v)}>
                <span>branches</span>
                {!showAllBranches && hiddenBranches > 0 && <span className="rp-more">+{hiddenBranches} more</span>}
                <I.chevD style={{ width: 10, height: 10, transform: showAllBranches ? 'none' : 'rotate(-90deg)' }} />
              </button>
            )}
            {branchList.map((b) => (
              <div key={b} className="lr-refpick-item" onClick={() => commit(b)}>
                <span className="ri-name" title={b}>{b}</span>
                {b === defaultBase && <span className="ri-tag">(default base)</span>}
              </div>
            ))}
            {commitList.length > 0 && (
              <div className="lr-refpick-sec">{matchedBranch ? `commits on ${matchedBranch}` : 'recent commits'}</div>
            )}
            {commitList.map((c) => (
              <div key={c.sha} className="lr-refpick-item" onClick={() => commit(c.sha)}>
                <span className="ri-name">{shortSha(c.sha)}</span>
                <span className="ri-sub" title={c.subject}>{c.subject}</span>
                <span className="ri-age">{ago(c.date)}</span>
              </div>
            ))}
            {commits === null && (
              <div className="dim" style={{ padding: 8, fontSize: 11.5 }}>loading…</div>
            )}
            {commits !== null && branchList.length === 0 && commitList.length === 0 && (
              <div className="dim" style={{ padding: 8, fontSize: 11.5 }}>No matches — press Enter to use "{trimmed}".</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
