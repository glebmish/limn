import { useEffect, useRef, useState } from 'react'
import { Dropdown } from './RepoSwitchers'
import { I, ago } from '../kit'
import { useStore } from '../store'
import { checkoutMatrix } from '../lib/worktreeMatrix'
import { wtName, branchLocation, reviewsForBranch } from '../lib/workspace'

/** Merged header-right control: the current review (or a draft) + where the
 *  compare branch is checked out ("detached" when nowhere). One stacked menu
 *  switches reviews and sets the checkout. The checkout section has no branch
 *  row — the branch is fixed (= compare) — so picking never moves the target,
 *  which is what removes the old "worktree jumps when I pick a branch" friction. */
export function WorkspacePicker({ branch }: { branch: string }) {
  const { repoState, repoSessions, sessionId, resumeExisting, checkoutInto, addWorktreeFor, newReview, enterHub } = useStore()
  const worktrees = repoState?.worktrees ?? []
  const primaryWt = worktrees.find((w) => w.primary) ?? worktrees[0]
  const repoBase = primaryWt ? primaryWt.path.split('/').pop() ?? '' : ''
  const name = (w: { path: string; primary: boolean }): string => wtName(w.path, w.primary, repoBase)

  const isBranch = !!repoState?.branches.includes(branch)
  const loc = branchLocation(branch, worktrees)
  const reviews = reviewsForBranch(repoSessions, branch)
  const cur = repoSessions.find((s) => s.id === sessionId)

  // checkout target: default to where the branch lives, else primary; re-default
  // when the selected branch or its resolved host changes.
  const [targetPath, setTargetPath] = useState<string>(loc.host?.path ?? primaryWt?.path ?? '')
  useEffect(() => { setTargetPath(loc.host?.path ?? primaryWt?.path ?? '') }, [branch, loc.host?.path]) // eslint-disable-line react-hooks/exhaustive-deps

  // inline new-worktree editor (null = closed) and a staged-but-uncreated name.
  const [newName, setNewName] = useState<string | null>(null)
  const [pendingWt, setPendingWt] = useState<string | null>(null)
  const firstRun = useRef(true)
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return }
    setNewName(null); setPendingWt(null)
  }, [branch])

  const matrix = checkoutMatrix(
    branch, isBranch,
    worktrees.map((w) => ({ path: w.path, branch: w.branch, primary: w.primary, dirty: !!w.dirty })),
    targetPath
  )

  const sessLabel = sessionId == null ? 'Session ‹new›' : (cur?.title ?? `Session #${sessionId}`)
  const locLabel = !isBranch ? 'commit' : loc.detached ? 'detached' : name(loc.host!)
  const detachedBranch = isBranch && loc.detached

  return (
    <Dropdown
      align="right"
      width={320}
      popClass="ws-pop"
      defaultOpen={Boolean(window.lrDev?.openWorkspace)}
      trigger={() => (
        <span className={'ws-trig' + (detachedBranch ? ' detached' : '')}>
          <span className={'ws-ssn' + (sessionId == null ? ' new' : '')}>{sessLabel}</span>
          <span className="ws-dot-sep" />
          <span className={'ws-loc' + (detachedBranch ? ' det' : '')}>
            {locLabel}{!loc.detached && loc.dirty && <span className="gdot" title="uncommitted changes" />}
          </span>
          <I.chevD style={{ width: 11, height: 11, color: 'var(--muted)' }} />
        </span>
      )}
    >
      {(close) => (
        <>
          {/* title is just the branch in context — the worktree-selection section
              below owns the word "checkout", so a top "Workspace" label only competed
              with it. */}
          <div className="ws-title"><I.branch style={{ width: 13, height: 13, color: 'var(--accent)' }} /><b title={branch}>{branch}</b></div>
          {detachedBranch && (
            <div className="ws-status"><I.warn style={{ width: 11, height: 11 }} />Detached — read-only until you check it out</div>
          )}

          <div className="rsw-head ws-sec">Reviews</div>
          {sessionId == null && (
            <div className="rsw-item on">
              <I.doc style={{ width: 12, height: 12 }} />
              <span className="rsw-item-t">Session ‹new›</span>
              <span className="ws-tag">draft</span>
              <I.check style={{ width: 11, height: 11, color: 'var(--accent)' }} />
            </div>
          )}
          {reviews.map((s) => (
            <button key={s.id} className={'rsw-item' + (s.id === sessionId ? ' on' : '')}
              onClick={() => { close(); if (s.id !== sessionId) void resumeExisting(s.id) }}>
              <I.doc style={{ width: 12, height: 12 }} />
              <span className="rsw-item-t" title={s.title ?? `Session #${s.id}`}>{s.title ?? `Session #${s.id}`}</span>
              <span className="rsw-age">{ago(s.updatedAt)}</span>
              {s.id === sessionId && <I.check style={{ width: 11, height: 11, color: 'var(--accent)' }} />}
            </button>
          ))}
          {/* on a draft, "Session ‹new›" above already IS the new review — showing
              "New review" too would be the same action twice, so offer it only when
              a saved session is loaded. */}
          {sessionId != null && (
            <button className="rsw-item" onClick={() => { close(); void newReview() }}>
              <I.plus style={{ width: 12, height: 12 }} /><span className="rsw-item-t">New review</span>
            </button>
          )}
          <button className="rsw-item" onClick={() => { close(); void enterHub() }}>
            <I.list style={{ width: 12, height: 12 }} /><span className="rsw-item-t">All repo sessions…</span>
          </button>

          <div className="rsw-sep" />
          <div className="rsw-head ws-sec">Checkout {detachedBranch && <span className="ws-badge">detached</span>}</div>

          {!isBranch ? (
            <div className="ws-note">A commit is review-only — branch from it to work on it.</div>
          ) : (
            <>
              {worktrees.map((w) => {
                const isHost = w.branch === branch
                const disabled = !!loc.host && !isHost
                const isSel = !pendingWt && w.path === targetPath && !disabled
                return (
                  <button key={w.path} className={'rsw-item' + (isSel ? ' on' : '')} title={w.path} disabled={disabled}
                    onClick={() => { setTargetPath(w.path); setPendingWt(null) }}>
                    <I.list style={{ width: 12, height: 12 }} />
                    <span className="rsw-item-t">{name(w)}</span>
                    {w.dirty && <span className="gdot" title="uncommitted changes" />}
                    {isHost
                      ? <I.check style={{ width: 12, height: 12, color: 'var(--accent)', marginLeft: 'auto' }} />
                      : <span className="bwp-holds">{w.branch ?? 'detached'}</span>}
                  </button>
                )
              })}

              {newName !== null ? (
                <div className="bwp-newwt">
                  <I.plus style={{ width: 12, height: 12 }} /><span className="bwp-wt-prefix">.worktrees/</span>
                  <input className="bwp-wt-input" autoFocus value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && newName.trim()) { setPendingWt(newName.trim()); setNewName(null) }
                      else if (e.key === 'Escape') { e.stopPropagation(); setNewName(null) }
                    }} />
                </div>
              ) : pendingWt !== null ? (
                <button className="rsw-item on" onClick={() => { setNewName(pendingWt); setPendingWt(null) }} title="Click to rename">
                  <I.plus style={{ width: 12, height: 12 }} /><span className="rsw-item-t">.worktrees/{pendingWt}</span><span className="ws-tag">new</span>
                </button>
              ) : (
                <button className="rsw-item" onClick={() => setNewName(branch)} disabled={!!loc.host}>
                  <I.plus style={{ width: 12, height: 12 }} /><span className="rsw-item-t">New worktree…</span>
                </button>
              )}

              {/* the action is pinned (sticky) at the popover's bottom edge so a long
                  worktree list can't scroll the checkout button out of reach. */}
              <div className="ws-foot">
                {pendingWt !== null ? (
                  <div className="bwp-act">
                    <button className="bwp-checkout"
                      onClick={() => { const n = pendingWt; close(); setPendingWt(null); void addWorktreeFor(branch, n) }}>
                      Check out into <b>.worktrees/{pendingWt}</b>
                    </button>
                  </div>
                ) : matrix.mode === 'checkout' ? (
                  <div className="bwp-act">
                    {matrix.dirtyBlocked && (
                      <div className="bwp-note"><I.warn style={{ width: 11, height: 11 }} />
                        {name(matrix.target)} has uncommitted changes — pick a clean worktree or create one.
                      </div>
                    )}
                    <button className="bwp-checkout" disabled={matrix.dirtyBlocked}
                      onClick={() => { close(); void checkoutInto(branch, matrix.target.path) }}>
                      Check out into {name(matrix.target)}
                    </button>
                    <div className="bwp-foot-note">unlocks generate · chat · send-to-agent</div>
                  </div>
                ) : (matrix.mode === 'goto-host' || matrix.mode === 'settled') ? (
                  <div className="ws-settled"><I.check style={{ width: 12, height: 12 }} />Checked out in {name(matrix.host)}</div>
                ) : null}
              </div>
            </>
          )}
        </>
      )}
    </Dropdown>
  )
}
