import { useEffect, useRef, useState } from 'react'
import { Dropdown } from './RepoSwitchers'
import { I } from '../kit'
import { useStore } from '../store'
import { checkoutMatrix } from '../lib/worktreeMatrix'
import { wtName, branchLocation } from '../lib/workspace'

/** Header-right worktree control: where the compare branch is checked out
 *  ("detached" when nowhere) and the action to check it out. Sessions are picked
 *  via the separate "Sessions" button now. The checkout section has no branch row
 *  — the branch is fixed (= compare) — so picking never moves the target. */
export function WorkspacePicker({ branch }: { branch: string }) {
  const { repoState, checkoutInto, addWorktreeFor } = useStore()
  const worktrees = repoState?.worktrees ?? []
  const primaryWt = worktrees.find((w) => w.primary) ?? worktrees[0]
  const repoBase = primaryWt ? primaryWt.path.split('/').pop() ?? '' : ''
  const name = (w: { path: string; primary: boolean }): string => wtName(w.path, w.primary, repoBase)

  const isBranch = !!repoState?.branches.includes(branch)
  const loc = branchLocation(branch, worktrees)

  // checkout target: default to where the branch lives, else primary; re-default
  // when the selected branch or its resolved host changes.
  const [targetPath, setTargetPath] = useState<string>(loc.host?.path ?? primaryWt?.path ?? '')
  // whether the reviewer actively picked a target — until then a detached branch
  // shows no row selected (the default-primary highlight reads as "current").
  const [picked, setPicked] = useState(false)
  useEffect(() => { setTargetPath(loc.host?.path ?? primaryWt?.path ?? ''); setPicked(false) }, [branch, loc.host?.path]) // eslint-disable-line react-hooks/exhaustive-deps

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

  const locLabel = !isBranch ? 'commit' : loc.detached ? 'detached' : name(loc.host!)
  const detachedBranch = isBranch && loc.detached

  return (
    <Dropdown
      align="right"
      width={320}
      popClass="ws-pop"
      defaultOpen={Boolean(window.lrDev?.openWorkspace)}
      trigger={() => (
        <span className={'ws-trig' + (detachedBranch ? ' detached' : '')} title="Where this branch is checked out">
          <I.layers style={{ width: 12, height: 12, color: detachedBranch ? 'var(--amber)' : 'var(--accent)', flex: '0 0 auto' }} />
          <span className={'ws-loc' + (detachedBranch ? ' det' : '')}>
            {locLabel}{!loc.detached && loc.dirty && <span className="gdot" title="uncommitted changes" />}
          </span>
          <I.chevD style={{ width: 11, height: 11, color: 'var(--muted)' }} />
        </span>
      )}
    >
      {(close) => (
        <>
          <div className="ws-title"><I.branch style={{ width: 13, height: 13, color: 'var(--accent)' }} /><b title={branch}>{branch}</b></div>
          {detachedBranch && (
            <div className="ws-status"><I.warn style={{ width: 11, height: 11 }} />Detached — read-only until you check it out</div>
          )}

          <div className="rsw-head ws-sec">Worktree {detachedBranch && <span className="ws-badge">detached</span>}</div>

          {!isBranch ? (
            <div className="ws-note">A commit is review-only — branch from it to work on it.</div>
          ) : (
            <>
              {worktrees.map((w) => {
                const isHost = w.branch === branch
                const disabled = !!loc.host && !isHost
                // a detached branch isn't checked out anywhere, so don't pre-select
                // the default target — only highlight once the reviewer picks one.
                const isSel = !pendingWt && w.path === targetPath && !disabled && (!loc.detached || picked)
                return (
                  <button key={w.path} className={'rsw-item' + (isSel ? ' on' : '')} title={w.path} disabled={disabled}
                    onClick={() => { setTargetPath(w.path); setPendingWt(null); setPicked(true) }}>
                    <I.layers style={{ width: 12, height: 12 }} />
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
