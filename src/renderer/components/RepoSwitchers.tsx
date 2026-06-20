import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useStore } from '../store'
import { I, ago } from '../kit'

/** A small button + outside-click popover, shared by the repo switchers. */
function Dropdown({ trigger, children, align = 'left', width }: {
  trigger: (open: boolean) => ReactNode
  children: (close: () => void) => ReactNode
  align?: 'left' | 'right'
  width?: number
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])
  return (
    <div className="rsw" ref={ref}>
      <button className="rsw-btn" onClick={() => setOpen((o) => !o)}>{trigger(open)}</button>
      {open && (
        <div className={'rsw-pop ' + align} style={width ? { width } : undefined}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  )
}

/** Branch picker = a real `git checkout` (refused on a dirty tree → the error
 *  toast shows "commit or stash first"). Picking a branch jumps to its latest
 *  session or the new-review setup. */
export function BranchSwitcher({ display }: { display?: string }) {
  const { repoState, switchBranchTo } = useStore()
  if (!repoState) return null
  const branches = repoState.branches
  // the branch this control represents: the review's compare branch when given
  // (it may live in a linked worktree, so it differs from the primary checkout),
  // else the primary's current branch.
  const shown = display ?? repoState.current
  return (
    <Dropdown
      width={240}
      trigger={() => (
        <><I.branch style={{ width: 12, height: 12, color: 'var(--accent)' }} />
          <b className="rsw-val">{shown}</b>
          <I.chevD style={{ width: 11, height: 11, color: 'var(--muted)' }} /></>
      )}
    >
      {(close) => (
        <>
          <div className="rsw-head">Switch branch <span className="rsw-sub">checks it out</span></div>
          {branches.map((b) => {
            const here = b === shown
            const wt = repoState.worktrees.find((w) => w.branch === b && !w.primary)
            return (
              <button key={b} className={'rsw-item' + (here ? ' on' : '')}
                onClick={() => { close(); if (!here) void switchBranchTo(b) }}>
                <I.branch style={{ width: 12, height: 12 }} />
                <span className="rsw-item-t">{b}</span>
                {here && <I.check style={{ width: 11, height: 11, color: 'var(--accent)' }} />}
                {wt && <span className="rsw-tag" title={wt.path}>worktree</span>}
              </button>
            )
          })}
          {repoState.dirty && (
            <div className="rsw-note"><I.warn style={{ width: 11, height: 11 }} />{repoState.dirtyCount} uncommitted — commit or stash to switch</div>
          )}
        </>
      )}
    </Dropdown>
  )
}

/** Worktrees for the repo. A branch is checked out in exactly one worktree, so
 *  this shows where each lives and which one holds the branch under review. */
export function WorktreeSwitcher({ compareBranch }: { compareBranch?: string }) {
  const { repoState } = useStore()
  if (!repoState || repoState.worktrees.length === 0) return null
  const host = repoState.worktrees.find((w) => w.branch === compareBranch)
  const label = host ? (host.primary ? 'primary' : host.path.split('/').pop()) : 'primary'
  return (
    <Dropdown
      align="right"
      width={320}
      trigger={() => (
        <><I.list style={{ width: 12, height: 12, color: 'var(--muted)' }} />
          <span className="rsw-val">{label}</span>
          <I.chevD style={{ width: 11, height: 11, color: 'var(--muted)' }} /></>
      )}
    >
      {() => (
        <>
          <div className="rsw-head">Worktrees <span className="rsw-sub">review + edits run where the branch lives</span></div>
          {repoState.worktrees.map((w) => (
            <div key={w.path} className={'rsw-item' + (w.branch === compareBranch ? ' on' : '')} title={w.path}>
              <I.list style={{ width: 12, height: 12 }} />
              <span className="rsw-item-t">{w.primary ? 'primary' : w.path.split('/').pop()}</span>
              <span className="rsw-tag">{w.branch ?? 'detached'}</span>
              {w.branch === compareBranch && <I.check style={{ width: 11, height: 11, color: 'var(--accent)' }} />}
            </div>
          ))}
          <div className="rsw-note" style={{ color: 'var(--muted)' }}>The compare branch's worktree is where the agent commits.</div>
        </>
      )}
    </Dropdown>
  )
}

/** Sessions reviewing the current branch (quick switch) + routes to the full
 *  hub list and the new-review setup. */
export function SessionSwitcher() {
  const { repoSessions, repoState, sessionId, resumeExisting, enterHub, newReview } = useStore()
  const branch = repoState?.current
  const here = repoSessions.filter((s) => !s.archived && s.compareKind === 'branch' && s.compareSymbol === branch)
  const cur = repoSessions.find((s) => s.id === sessionId)
  return (
    <Dropdown
      width={300}
      trigger={() => (
        <><span className="rsw-lab">Session</span>
          <span className="rsw-val">{cur?.title ?? (cur ? `#${cur.id}` : '—')}</span>
          <I.chevD style={{ width: 11, height: 11, color: 'var(--muted)' }} /></>
      )}
    >
      {(close) => (
        <>
          {here.length > 0 && <div className="rsw-head">On {branch}</div>}
          {here.map((s) => (
            <button key={s.id} className={'rsw-item' + (s.id === sessionId ? ' on' : '')}
              onClick={() => { close(); if (s.id !== sessionId) void resumeExisting(s.id) }}>
              <I.doc style={{ width: 12, height: 12 }} />
              <span className="rsw-item-t">{s.title ?? `Session #${s.id}`}</span>
              <span className="rsw-age">{ago(s.updatedAt)}</span>
            </button>
          ))}
          <div className="rsw-sep" />
          <button className="rsw-item" onClick={() => { close(); void enterHub() }}>
            <I.list style={{ width: 12, height: 12 }} /><span className="rsw-item-t">All sessions…</span>
          </button>
          <button className="rsw-item" onClick={() => { close(); void newReview() }}>
            <I.plus style={{ width: 12, height: 12 }} /><span className="rsw-item-t">New review</span>
          </button>
        </>
      )}
    </Dropdown>
  )
}
