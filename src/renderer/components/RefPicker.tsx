import { useEffect, useRef, useState } from 'react'
import { I, ago, shortSha } from '../kit'
import { usePopover } from '../lib/usePopover'
import { useStore } from '../store'
import { wtName } from '../lib/workspace'
import type { CommitInfo, RefLoc } from '../../shared/types'
import { dev } from '../dev'

export function RefPicker({ value, onChange, repo, relativeTo, label, prominent = false, loc }: {
  value: string
  onChange: (v: string) => void
  repo: string
  relativeTo: string
  label: string
  /** Compare side: render the trigger as a bold chip with a branch icon. Base
   *  side (default) stays the quiet text button. */
  prominent?: boolean
  /** structured locator: render the chip as "branch ~n sha" — the branch the ref
   *  lives on, how far behind that branch's HEAD it sits (~n, hidden at the tip),
   *  and its sha in grey. Omitted (e.g. the setup screen) → plain value display. */
  loc?: RefLoc
}) {
  // open state + on-screen positioning (flips up / clamps to the viewport) +
  // outside-click dismissal, all from the shared popover hook.
  const { open, toggle, close, anchorRef, floatingRef, popStyle } = usePopover<HTMLButtonElement, HTMLDivElement>({ side: 'bottom', align: 'start', gap: 4, defaultOpen: Boolean(prominent && dev.openCmpRef) })
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
  // ref-options load failed — surface it instead of a forever "loading…" row.
  const [loadErr, setLoadErr] = useState(false)
  // expand the branch list past the live text filter — when the input names a
  // branch the filtered list collapses to one, so this reveals the rest to switch.
  const [showAllBranches, setShowAllBranches] = useState(true)
  // commits are the additional mode: collapsed by default (branch picking is the
  // default), opened by the toggle or automatically once the query looks like a SHA.
  const [showCommits, setShowCommits] = useState(false)
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
    setLoadErr(false)
    let ignore = false
    void window.api.refOptions(repo, scope).then((r) => {
      if (ignore) return
      setBranches(r.branches)
      setDefaultBase(r.defaultBase)
      setCommits(r.commits)
    }).catch(() => { if (!ignore) { setCommits([]); setLoadErr(true) } })
    return () => { ignore = true }
  }, [open, repo, scope])

  const commit = (v: string): void => {
    onChange(v)
    close()
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
  // the branch the commit list is scoped to (matched input, else the side's own
  // ref) — names the "commits on <branch>" header so you know whose history it is.
  const scopeBranch = branches.includes(scope) ? scope : null

  // the trigger shows a long full SHA truncated to 7 chars; branch names and
  // HEAD~N stay verbatim. (Hovering the trigger still shows the full value.)
  const valueShaLike = /^[0-9a-f]{7,40}$/i.test(value)
  const display = valueShaLike ? shortSha(value) : value
  const triggerTitle = loc
    ? [
        `${label}: ${loc.onBranch ?? value}`,
        `resolved: ${loc.sha}`,
        loc.onBranch ? (loc.behind > 0 ? `${loc.behind} commit${loc.behind === 1 ? '' : 's'} behind ${loc.onBranch}` : `at ${loc.onBranch} tip`) : null,
        loc.kind === 'commit' ? 'pinned commit - does not follow branch movement' : 'branch ref - follows the tip'
      ].filter(Boolean).join('\n')
    : value ? `${label}: ${value}` : label

  return (
    <div className="limn-refpick">
      <button ref={anchorRef} className={'limn-refpick-btn' + (prominent ? ' limn-refpick-cmp' : '')} title={triggerTitle} onClick={() => { setDraft(''); setShowAllBranches(true); setShowCommits(false); toggle() }}>
        {prominent && loc?.kind !== 'commit' && <I.branch style={{ width: 12, height: 12, color: 'var(--accent)' }} />}
        {loc ? (
          <>
            <span className="rp-val">{loc.onBranch ?? shortSha(loc.sha)}</span>
            {loc.behind > 0 && <span className="rp-dist">~{loc.behind}</span>}
            {loc.onBranch && <span className="rp-tip">{shortSha(loc.sha)}</span>}
            {loc.kind === 'commit' && (
              <span className="rp-pin" title="Pinned to this commit — reviews exactly this state; won't follow new commits. Pick a branch to track the tip.">
                <I.pin style={{ width: 9, height: 9, transform: 'rotate(45deg)' }} />
              </span>
            )}
          </>
        ) : (
          <span className="rp-val">{display || '—'}</span>
        )}
        {prominent && <I.chevD style={{ width: 11, height: 11, color: 'var(--muted)' }} />}
      </button>
      {open && (
        <div className="limn-refpick-pop" ref={floatingRef} style={popStyle}>
          <input
            autoFocus
            value={draft}
            placeholder="branch, SHA, or HEAD~N"
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => { setDraft(e.target.value); setShowAllBranches(false) }}
            onKeyDown={(e) => { if (e.nativeEvent.isComposing) return; if (e.key === 'Enter' && draft.trim()) commit(draft.trim()) }}
          />
          <div className="limn-refpick-list">
            {loadErr && (
              <div className="dim" style={{ padding: 8, fontSize: 11.5 }}>Couldn't load refs — press Enter to use what you typed.</div>
            )}
            {branches.length > 0 && (
              <button type="button" className="limn-refpick-sec limn-refpick-sec-btn"
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
                <div key={b} role="button" tabIndex={0} className="limn-refpick-item" title={at ? `${b}\nchecked out in ${at}` : b} onClick={() => commit(b)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); commit(b) } }}>
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
              <button type="button" className="limn-refpick-sec limn-refpick-sec-btn"
                onClick={() => setShowCommits((v) => !v)}>
                <span>{scopeBranch ? `commits on ${scopeBranch}` : 'recent commits'}</span>
                {!commitsOpen && commits && commits.length > 0 && <span className="rp-more">+{commits.length}</span>}
                <I.chevD style={{ width: 10, height: 10, transform: commitsOpen ? 'none' : 'rotate(-90deg)' }} />
              </button>
            )}
            {commitsOpen && commits === null && (
              <div className="dim" style={{ padding: 8, fontSize: 11.5 }}>loading…</div>
            )}
            {commitsOpen && commitList.map((c) => (
              // row-level title (like the branch rows above) so hovering anywhere
              // on the commit — sha, subject, or age — shows the full message.
              <div key={c.sha} role="button" tabIndex={0} className="limn-refpick-item" title={`${c.subject}\n${shortSha(c.sha)} · ${ago(c.date)}`} onClick={() => commit(c.sha)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); commit(c.sha) } }}>
                <span className="ri-name ri-sha">{shortSha(c.sha)}</span>
                <span className="ri-sub">{c.subject}</span>
                <span className="ri-age">{ago(c.date)}</span>
              </div>
            ))}
            {!loadErr && commits !== null && branchList.length === 0 && commitList.length === 0 && (
              <div className="dim" style={{ padding: 8, fontSize: 11.5 }}>No matches — press Enter to use "{trimmed}".</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
