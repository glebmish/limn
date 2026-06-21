import { useEffect, useRef, useState } from 'react'
import { I, ago, shortSha } from '../kit'
import { useStore } from '../store'
import { wtName } from '../lib/workspace'
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
  const [open, setOpen] = useState(Boolean(prominent && window.lrDev?.openCmpRef))
  // worktree a branch is checked out in (if any) — shown muted next to the row so
  // you can see at a glance which branches are already checked out, and where.
  const worktrees = useStore((s) => s.repoState?.worktrees) ?? []
  const primaryWt = worktrees.find((w) => w.primary) ?? worktrees[0]
  const repoBase = primaryWt ? primaryWt.path.split('/').pop() ?? '' : ''
  const wtFor = (b: string): string | null => {
    const w = worktrees.find((wt) => wt.branch === b)
    return w ? wtName(w.path, w.primary, repoBase) : null
  }
  const [draft, setDraft] = useState(value)
  const [branches, setBranches] = useState<string[]>([])
  const [defaultBase, setDefaultBase] = useState('')
  const [commits, setCommits] = useState<CommitInfo[] | null>(null)
  // expand the branch list past the live text filter — when the input names a
  // branch the filtered list collapses to one, so this reveals the rest to switch.
  const [showAllBranches, setShowAllBranches] = useState(true)
  // commits are the additional mode: collapsed by default (branch picking is the
  // default), opened by the toggle or automatically once the query looks like a SHA.
  const [showCommits, setShowCommits] = useState(false)
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
  // typing a hash should surface commits without a click — auto-open the section
  // when the input reads as a SHA (and isn't an exact branch name).
  const shaLike = /^[0-9a-f]{4,40}$/i.test(trimmed) && !matchedBranch
  const commitsOpen = showCommits || shaLike

  return (
    <div className="lr-refpick">
      <button className={'lr-refpick-btn' + (prominent ? ' lr-refpick-cmp' : '')} title={value ? `${label}: ${value}` : label} onClick={() => { setDraft(value); setShowAllBranches(true); setShowCommits(false); setOpen((o) => !o) }}>
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
            onFocus={(e) => e.currentTarget.select()}
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
            {branchList.map((b) => {
              const at = wtFor(b)
              return (
                // one title on the whole row (not per-span) — native tooltips reset
                // when the pointer crosses child elements, which made hovering flicker
                // and dropped the worktree detail. Row-level keeps it stable end to end.
                <div key={b} className="lr-refpick-item" title={at ? `${b}\nchecked out in ${at}` : b} onClick={() => commit(b)}>
                  <span className="ri-name">{b}</span>
                  {b === defaultBase && <span className="ri-tag">(default base)</span>}
                  {at && (
                    // worktree = just the git branch-off icon; the name lives in the
                    // row tooltip (keeps long worktree names from ever crowding the row).
                    <span className="ri-at"><I.branch style={{ width: 12, height: 12 }} /></span>
                  )}
                </div>
              )
            })}
            {(commits === null || commits.length > 0) && (
              <button type="button" className="lr-refpick-sec lr-refpick-sec-btn"
                onClick={() => setShowCommits((v) => !v)}>
                <span>{matchedBranch ? `commits on ${matchedBranch}` : 'recent commits'}</span>
                {!commitsOpen && commits && commits.length > 0 && <span className="rp-more">+{commits.length}</span>}
                <I.chevD style={{ width: 10, height: 10, transform: commitsOpen ? 'none' : 'rotate(-90deg)' }} />
              </button>
            )}
            {commitsOpen && commits === null && (
              <div className="dim" style={{ padding: 8, fontSize: 11.5 }}>loading…</div>
            )}
            {commitsOpen && commitList.map((c) => (
              <div key={c.sha} className="lr-refpick-item" onClick={() => commit(c.sha)}>
                <span className="ri-name">{shortSha(c.sha)}</span>
                <span className="ri-sub" title={c.subject}>{c.subject}</span>
                <span className="ri-age">{ago(c.date)}</span>
              </div>
            ))}
            {commits !== null && branchList.length === 0 && commitList.length === 0 && (
              <div className="dim" style={{ padding: 8, fontSize: 11.5 }}>No matches — press Enter to use "{trimmed}".</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
