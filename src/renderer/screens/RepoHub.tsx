import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { I, ago } from '../kit'
import { RefPicker } from '../components/RefPicker'
import { SessionRow } from '../components/SessionRow'
import { usePopover } from '../lib/usePopover'
import type { RepoIndexEntry, RepoState } from '../../shared/types'

const tilde = (p: string): string => p.replace(/^\/(?:Users|home)\/[^/]+/, '~')
const baseName = (p: string): string => p.split('/').filter(Boolean).pop() ?? p

function RepoGlyph({ cls, size = 14 }: { cls: string; size?: number }) {
  return (
    <svg className={cls} viewBox="0 0 14 14" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.5}>
      <path d="M3 2.4h6.4a1 1 0 0 1 1 1v8.2H4.3A1.3 1.3 0 0 1 3 10.3V2.4Z M3 9.7h6.7" />
    </svg>
  )
}

/** Level-2 spine: the repo identity is a dropdown to hop between repos without
 *  backing out to the index. Lists the other repos (activity-sorted) + Open
 *  repository… */
function RepoSwitcher({ repo, repos, onSwitch, onOpenRepository }: {
  repo: string
  repos: RepoIndexEntry[]
  onSwitch: (path: string) => void
  onOpenRepository: () => void
}) {
  const [q, setQ] = useState('')
  const { open, toggle, close, anchorRef, floatingRef, popStyle: menuStyle } = usePopover<HTMLSpanElement, HTMLDivElement>({ side: 'bottom', align: 'start' })
  const f = q.trim().toLowerCase()
  const list = repos.filter((r) => !f || baseName(r.path).toLowerCase().includes(f) || r.path.toLowerCase().includes(f))
  return (
    <span className={'limn-repo-switchwrap' + (open ? ' open' : '')}>
      <span ref={anchorRef} className="limn-repo-switch" title="Switch repository" onClick={toggle}>
        <RepoGlyph cls="rs-glyph" />
        <span className="rs-name">{baseName(repo)}</span>
        <span className="rs-path">{tilde(repo)}</span>
        <span className="rs-caret"><I.chevD style={{ width: 11, height: 11 }} /></span>
      </span>
      {open && (
        <div className="limn-repo-menu" ref={floatingRef} style={menuStyle} onClick={(e) => e.stopPropagation()}>
          <div className="rm-search">
            <input autoFocus placeholder="Switch repository…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          {list.map((r) => {
            const cur = r.path === repo
            return (
              <div key={r.path} className={'limn-repo-opt' + (cur ? ' cur' : '')}
                onClick={() => { close(); if (!cur) onSwitch(r.path) }}>
                <RepoGlyph cls="ro-glyph" size={13} />
                <span className="ro-name">{baseName(r.path)}</span>
                <span className="ro-path">{tilde(r.path)}</span>
                <span className="ro-age">{ago(r.lastActivity)}</span>
                {cur && <I.check className="ro-check" style={{ width: 12, height: 12 }} />}
              </div>
            )
          })}
          <div className="rm-sep" />
          <div className="rm-open" onClick={() => { close(); onOpenRepository() }}>
            <I.folder style={{ width: 12, height: 12 }} />Open repository…
          </div>
        </div>
      )}
    </span>
  )
}

/** "New review" split control: the button starts a fresh review on the current
 *  branch; the caret opens a base←compare popover to pick a specific pair first. */
function NewReviewSplit({ repo, repoState, onStart }: {
  repo: string
  repoState: RepoState | null
  onStart: (base: string, compare: string) => void
}) {
  const [base, setBase] = useState('')
  const [cmp, setCmp] = useState('')
  const { open, toggle, close, anchorRef, floatingRef, popStyle } = usePopover<HTMLButtonElement, HTMLDivElement>({ side: 'bottom', align: 'end' })
  const effBase = base || repoState?.defaultBase || 'HEAD'
  const effCmp = cmp || repoState?.current || ''
  return (
    <div className={'limn-repo-newwrap' + (open ? ' open' : '')}>
      <button className="limn-repo-new" onClick={() => onStart(effBase, repoState?.current ?? '')} title="Fresh review on the current branch">
        <I.plus style={{ width: 11, height: 11 }} />New review
      </button>
      <button ref={anchorRef} className="limn-repo-new-caret" title="Choose base ← compare" onClick={toggle}>
        <I.chevD style={{ width: 11, height: 11 }} />
      </button>
      {open && (
        <div className="limn-repo-new-pop" ref={floatingRef} style={popStyle} onClick={(e) => e.stopPropagation()}>
          <p className="np-h">Start a review</p>
          <div className="np-refs">
            <span className="rv-refs">
              <RefPicker value={effBase} onChange={setBase} repo={repo} relativeTo={effCmp || 'HEAD'} label="base ref" />
              <span className="rv-arrow">←</span>
              <RefPicker value={effCmp} onChange={setCmp} repo={repo} relativeTo={effBase} label="compare ref" prominent />
            </span>
          </div>
          <div className="np-act">
            <button className="btn btn-sm btn-primary" disabled={!effCmp}
              onClick={() => { close(); onStart(effBase, effCmp) }}>
              <I.plus style={{ width: 12, height: 12 }} />Start review
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export default function RepoHub() {
  const {
    repo, repoState, repoSessions, showArchived, dashboard, error,
    backToDashboard, enterHub, resumeExisting, deleteSession, restoreSession, toggleArchived, openReview, openRepository
  } = useStore()
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)

  const f = q.trim().toLowerCase()
  const match = (s: typeof repoSessions[number]): boolean =>
    !f || (s.title?.toLowerCase().includes(f) ?? false) || s.compareSymbol.toLowerCase().includes(f)
  const live = repoSessions.filter((s) => !s.archived && match(s))
  const archived = repoSessions.filter((s) => s.archived && match(s))

  // keep the keyboard cursor over the currently-visible (filtered) live rows
  const liveRef = useRef(live)
  liveRef.current = live
  const selRef = useRef(sel)
  selRef.current = sel

  // keyboard: ↑↓ move the cursor over live rows, ⏎ open the selected review,
  // ⌫ back to repositories, ⌘O open a repository. Skip nav keys while typing in
  // the filter so ⌫ deletes text rather than navigating away.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const active = document.activeElement
      const typing = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'o') { e.preventDefault(); void openRepository(); return }
      if (typing) return
      const list = liveRef.current
      if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(list.length - 1, s + 1)); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); return }
      if (e.key === 'Enter') { e.preventDefault(); const s = liveRef.current[selRef.current]; if (s) void resumeExisting(s.id); return }
      if (e.key === 'Backspace') { e.preventDefault(); void backToDashboard(); return }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!repo) return null

  // other repos for the switcher (self is shown as current); fall back to just self
  const repos = dashboard?.repos ?? []

  const startReview = (base: string, compare: string): void => {
    if (compare) void openReview(repo, { base, compare }, { fresh: true })
  }

  return (
    <div className="limn-dash">
      <div className="wf-titlebar">
        <span className="wf-title"><span className="wf-mark"><I.mark style={{ width: 15, height: 15 }} /></span><b>Limn</b></span>
      </div>

      <div className="limn-dash-head">
        <button className="btn btn-sm btn-ghost limn-back" onClick={() => backToDashboard()} title="Back to repositories">
          <I.arrow style={{ width: 12, height: 12, transform: 'rotate(180deg)' }} />Repositories
        </button>
        <RepoSwitcher repo={repo} repos={repos} onSwitch={(p) => void enterHub(p)} onOpenRepository={() => void openRepository()} />
        <span className="grow" />
        <button className={'btn btn-sm btn-ghost limn-filter-arch' + (showArchived ? ' on' : '')} onClick={() => void toggleArchived()}>
          <I.eye style={{ width: 12, height: 12 }} />{showArchived ? 'Hide archived' : 'Show archived'}
        </button>
        <NewReviewSplit repo={repo} repoState={repoState} onStart={startReview} />
      </div>

      <div className="limn-dash-filter">
        <input placeholder="Filter this repo's sessions…" aria-label="Filter sessions"
          value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      {error && <div className="limn-error limn-toast">{error}</div>}

      <div className="limn-dash-scroll">
        <div className="limn-sesslist">
          {live.length === 0 && (
            <div className="limn-empty">{f ? <>No sessions match <b>{q}</b>.</> : <>No reviews yet for this repo. <b>New review</b> to start one.</>}</div>
          )}
          {live.map((s, i) => (
            <SessionRow key={s.id} s={s} chip selected={sel === i}
              onOpen={() => void resumeExisting(s.id)} onDelete={() => void deleteSession(s.id)} />
          ))}

          {showArchived && (
            <>
              <div className="limn-arch-sech"><span>Archived · {archived.length}</span></div>
              {archived.length === 0 && <div className="limn-empty">No archived reviews.</div>}
              {archived.map((s) => (
                <SessionRow key={s.id} s={s} chip
                  onOpen={() => void resumeExisting(s.id)} onRestore={() => void restoreSession(s.id)} />
              ))}
            </>
          )}
        </div>
      </div>

      <div className="limn-foot-hint">↑↓ navigate · ⏎ open review · ⌫ back to repos · ⌘O open repository</div>
    </div>
  )
}
