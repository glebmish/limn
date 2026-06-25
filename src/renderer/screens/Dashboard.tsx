import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { I, ago } from '../kit'
import { useDismiss } from '../lib/useDismiss'
import type { RepoIndexEntry, WorktreeInfo } from '../../shared/types'

/** Collapse the user's home prefix to ~ for the path line (cosmetic only). */
const tilde = (p: string): string => p.replace(/^\/(?:Users|home)\/[^/]+/, '~')
const repoName = (p: string): string => p.split('/').filter(Boolean).pop() ?? p

/** Repo glyph (folder with fold) — shared by index rows and the empty state. */
function RepoGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg className="rr-glyph" viewBox="0 0 14 14" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.5}>
      <path d="M3 2.4h6.4a1 1 0 0 1 1 1v8.2H4.3A1.3 1.3 0 0 1 3 10.3V2.4Z M3 9.7h6.7" />
    </svg>
  )
}

/** The "+n worktrees" pill on a repo row: a count plus a dropdown of the repo's
 *  linked checkouts. Each entry opens that branch's review. */
function WorktreePill({ entry, onOpen }: { entry: RepoIndexEntry; onOpen: (branch: string) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  useDismiss(open, () => setOpen(false), ref)
  const linked = entry.worktrees.filter((w) => !w.primary)
  if (linked.length === 0) return null
  // current first, then the linked ones in their listed order
  const ordered = [...entry.worktrees].sort((a, b) => Number(b.primary) - Number(a.primary))
  return (
    <span ref={ref} className={'rr-worktrees' + (open ? ' open' : '')} title={`${linked.length} linked worktree${linked.length === 1 ? '' : 's'}`}
      onClick={(e) => { e.stopPropagation(); setOpen((o) => !o) }}>
      <I.folder style={{ width: 10, height: 10 }} />+{linked.length} worktree{linked.length === 1 ? '' : 's'}
      {open && (
        <span className="wt-menu" onClick={(e) => e.stopPropagation()}>
          <span className="wm-h">Worktrees · {repoName(entry.path)}</span>
          {ordered.map((w: WorktreeInfo) => (
            <span key={w.path} className="wt-opt"
              onClick={() => { if (w.branch) onOpen(w.branch) }}>
              <I.folder className="wo-ico" style={{ width: 12, height: 12 }} />
              <span className="wo-branch">{w.branch ?? '(detached)'}</span>
              <span className="wo-path">{tilde(w.path)}</span>
              {w.primary && <span className="wo-cur">current</span>}
            </span>
          ))}
        </span>
      )}
    </span>
  )
}

/** One repository row in the Level-1 index. */
function RepoRow({ entry, selected, onEnter, onOpenBranch }: {
  entry: RepoIndexEntry
  selected: boolean
  onEnter: () => void
  onOpenBranch: (branch: string) => void
}) {
  const detached = entry.current === 'HEAD'
  const sameAsBase = entry.current === entry.defaultBase
  const tip = detached ? 'detached HEAD' : sameAsBase ? `review · ${entry.current}` : `${entry.defaultBase} ← ${entry.current}`
  return (
    <div className={'limn-repo-row' + (selected ? ' sel' : '')} onClick={onEnter} title={`${repoName(entry.path)} — open sessions`}>
      <RepoGlyph />
      <span className="rr-name">{repoName(entry.path)}</span>
      <span className="rr-path">{tilde(entry.path)}</span>
      <span className="grow" />
      <span className="limn-chip" title="Open this branch's review"
        onClick={(e) => { e.stopPropagation(); if (!detached) onOpenBranch(entry.current) }}>
        <I.branch style={{ width: 10, height: 10 }} />{detached ? 'detached' : entry.current}
        <span className="chip-tip">{tip}</span>
      </span>
      <WorktreePill entry={entry} onOpen={onOpenBranch} />
      <span className="rr-age" title={`last activity ${ago(entry.lastActivity)}`}>{ago(entry.lastActivity).replace(' ago', '')}</span>
      <I.chevR className="rr-chev" style={{ width: 13, height: 13 }} />
    </div>
  )
}

export default function Dashboard() {
  const { dashboard, filter, sel, repo, error, boot, setFilter, openRepository, enterHub, openReview } = useStore()
  const filterRef = useRef<HTMLInputElement>(null)

  useEffect(() => { void boot() }, [boot])

  // pre-select the repo you last drilled into, so returning from a repo's sessions
  // (Back) lands the cursor where you were rather than at the top.
  useEffect(() => {
    if (!dashboard) return
    const idx = repo ? dashboard.repos.findIndex((r) => r.path === repo) : -1
    useStore.setState({ sel: idx >= 0 ? idx : 0 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dashboard])

  const repos: RepoIndexEntry[] = useMemo(() => {
    const all = dashboard?.repos ?? []
    const f = filter.trim().toLowerCase()
    if (!f) return all
    return all.filter((r) =>
      repoName(r.path).toLowerCase().includes(f) || r.path.toLowerCase().includes(f) || r.current.toLowerCase().includes(f)
    )
  }, [dashboard, filter])

  // keep the keyboard cursor in range as the filtered list shrinks
  const reposRef = useRef(repos)
  reposRef.current = repos

  const openRepoSessions = (path: string): void => { void enterHub(path) }
  const openBranch = (path: string, branch: string): void => { void openReview(path, { compare: branch }) }

  // keyboard: ↑↓ select, ⏎ open the repo's sessions, ⌘O open a repository,
  // Esc clears the filter, plain typing focuses it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const active = document.activeElement
      const typing = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
      const list = reposRef.current
      if (e.key === 'Escape') { setFilter(''); if (filterRef.current) filterRef.current.value = ''; return }
      if (e.key === 'ArrowDown') { e.preventDefault(); useStore.setState({ sel: Math.min(list.length - 1, useStore.getState().sel + 1) }); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); useStore.setState({ sel: Math.max(0, useStore.getState().sel - 1) }); return }
      if (e.key === 'Enter') {
        e.preventDefault()
        const r = reposRef.current[useStore.getState().sel]
        if (r) void useStore.getState().enterHub(r.path)
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'o') { e.preventDefault(); void useStore.getState().openRepository(); return }
      if (!typing && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) filterRef.current?.focus()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const hasRepos = (dashboard?.repos.length ?? 0) > 0

  return (
    <div className="limn-dash">
      <div className="wf-titlebar">
        <span className="wf-title"><span className="wf-mark"><I.mark style={{ width: 15, height: 15 }} /></span><b>Limn</b></span>
      </div>

      <div className="limn-dash-head">
        <h1>Repositories</h1>
        <button className="btn btn-sm btn-ghost" onClick={() => void openRepository()} title="Open a Git repository (⌘O)">
          <I.folder style={{ width: 12, height: 12 }} />Open…
        </button>
        <span className="grow" />
      </div>

      {hasRepos && (
        <div className="limn-dash-filter">
          <input
            ref={filterRef}
            placeholder="Filter repositories…"
            aria-label="Filter repositories"
            defaultValue={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
      )}

      {error && <div className="limn-error limn-toast">{error}</div>}

      <div className="limn-dash-scroll">
        {!dashboard && <div className="dim" style={{ padding: 20 }}>Loading…</div>}

        {dashboard && !hasRepos && (
          <div className="limn-firstrun">
            <div className="fr-glyph">
              <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round">
                <path d="M3 19V6a1.3 1.3 0 0 1 1.3-1.3h4.6l2 2.5h8.5a1.3 1.3 0 0 1 1.3 1.3V19a1.3 1.3 0 0 1-1.3 1.3H4.3A1.3 1.3 0 0 1 3 19z" />
                <path d="M9 13.5h6M12 10.5v6" />
              </svg>
            </div>
            <h2>No repositories yet</h2>
            <p className="fr-sub">Open a Git repository to start your first review. Limn adds it here and drops you straight into the diff for the current branch.</p>
            <div className="fr-cta">
              <button className="btn btn-primary" onClick={() => void openRepository()}>
                <I.branch style={{ width: 13, height: 13 }} />Open repository…
              </button>
              <span className="fr-kbd"><kbd>⌘</kbd><kbd>O</kbd></span>
            </div>
          </div>
        )}

        {dashboard && hasRepos && repos.length === 0 && (
          <div className="limn-empty">No repositories match <b>{filter}</b>.</div>
        )}

        {repos.map((r, i) => (
          <RepoRow
            key={r.path}
            entry={r}
            selected={sel === i}
            onEnter={() => openRepoSessions(r.path)}
            onOpenBranch={(branch) => openBranch(r.path, branch)}
          />
        ))}
      </div>

      <div className="limn-foot-hint">↑↓ navigate · ⏎ open repo · type to filter · ⌘O open repository</div>
    </div>
  )
}
