import { useState } from 'react'
import { useStore } from '../store'
import { I, ago } from '../kit'
import { RefPicker } from '../components/RefPicker'

export default function RepoHub() {
  const { repo, repoState, repoSessions, showArchived, hubReturn, error, backToDashboard, resumeExisting, deleteSession, restoreSession, toggleArchived, openReview } = useStore()
  // base for a new review (compare defaults to the current branch); empty = repo default
  const [base, setBase] = useState('')
  const effBase = base || repoState?.defaultBase || 'HEAD'
  if (!repo) return null
  const repoName = repo.split('/').pop()
  const live = repoSessions.filter((s) => !s.archived)
  const archived = repoSessions.filter((s) => s.archived)


  // group sessions under their compare branch; the checked-out branch floats to
  // the top, the rest order by their most-recent session.
  const groupByBranch = (list: typeof repoSessions): [string, typeof repoSessions][] => {
    const groups = new Map<string, typeof repoSessions>()
    for (const s of list) {
      const arr = groups.get(s.compareSymbol) ?? []
      arr.push(s); groups.set(s.compareSymbol, arr)
    }
    const recency = (g: typeof repoSessions): string => g.reduce((m, s) => (s.updatedAt > m ? s.updatedAt : m), '')
    return [...groups.entries()].sort((a, b) => {
      if (a[0] === repoState?.current) return -1
      if (b[0] === repoState?.current) return 1
      return recency(a[1]) < recency(b[1]) ? 1 : -1
    })
  }

  return (
    <div className="lr-hub">
      <div className="wf-titlebar">
        <span className="lr-cmp-repo" title={repo}><b>{repoName}</b> · {repo}</span>
        <span className="grow" />
        {hubReturn != null && (
          <button className="btn btn-sm btn-ghost rv-sessions" onClick={() => void resumeExisting(hubReturn)} title="Back to the review you came from">
            <I.arrow style={{ width: 12, height: 12, transform: 'rotate(180deg)' }} />Back
          </button>
        )}
        <button className="btn btn-sm btn-ghost" onClick={() => backToDashboard()} title="All repositories">
          <I.home style={{ width: 12, height: 12 }} />repos
        </button>
      </div>

      <div className="lr-hub-bar">
        <span className="rv-refs">
          <RefPicker value={effBase} onChange={setBase} repo={repo} relativeTo={repoState?.current ?? 'HEAD'} label="base ref" />
          <span className="rv-arrow" title="base ← compare (changes the compare branch adds over the base)">←</span>
          <RefPicker value={repoState?.current ?? ''} repo={repo} relativeTo={effBase} label="compare ref" prominent
            onChange={(v) => { void openReview(repo, { base: effBase, compare: v }) }} />
        </span>
        <span className="grow" />
        <button className="btn btn-sm btn-primary" onClick={() => void openReview(repo, { base: effBase, compare: repoState?.current }, { fresh: true })}>
          <I.plus style={{ width: 12, height: 12 }} />New review
        </button>
      </div>

      {error && <div className="lr-error lr-toast">{error}</div>}

      <div className="lr-hub-scroll">
        <div className="lr-hub-sech">
          <span>Sessions</span>
          <span className="grow" />
          <button className={'btn btn-sm btn-ghost' + (showArchived ? ' on' : '')} onClick={() => void toggleArchived()}>
            <I.eye style={{ width: 12, height: 12 }} />{showArchived ? 'Hide archived' : 'Show archived'}
          </button>
        </div>
        {live.length === 0 && (
          <div className="lr-empty">No reviews yet for this repo. <b>New review</b> to start one.</div>
        )}
        {groupByBranch(live).map(([branch, sessions]) => (
          <div key={branch} className="lr-hub-group">
            <div className="lr-hub-branch">
              <I.branch style={{ width: 12, height: 12, color: 'var(--accent)' }} />
              <b title={branch}>{branch}</b>
            </div>
            {sessions.map((s) => renderRow(s, true))}
          </div>
        ))}

        {showArchived && (
          <>
            <div className="lr-hub-sech" style={{ marginTop: 22 }}><span>Archived</span></div>
            {archived.length === 0 && <div className="lr-empty">No archived reviews.</div>}
            {archived.map((s) => renderRow(s))}
          </>
        )}
      </div>
    </div>
  )

  function renderRow(s: typeof repoSessions[number], grouped = false) {
    const onActive = !s.archived && s.compareKind === 'branch' && s.compareSymbol === repoState?.current
    const status = s.approved ? 'approved' : s.unresolved > 0 ? `${s.unresolved} unresolved` : s.hasReview ? 'reviewed' : 'not generated'
    const statusKind = s.approved ? 'ok' : s.unresolved > 0 ? 'warn' : 'dim'
    return (
      <div key={s.id} className={'lr-sess' + (grouped ? ' grouped' : '') + (onActive ? ' active' : '') + (s.archived ? ' archived' : '')} onClick={() => void resumeExisting(s.id)}>
        <span className={'lr-sess-dot ' + (onActive ? 'on' : '')} />
        {grouped ? (
          // grouped under the compare branch header — only the base differs per row.
          <span className="lr-sess-refs" title="changes this branch adds over the base"><span className="b-base">over {s.baseSymbol}</span></span>
        ) : (
          <span className="lr-sess-refs" title="base ← compare (changes this branch adds over the base)">
            <span className="b-base">{s.baseSymbol}</span>
            <I.arrow style={{ width: 11, height: 11, color: 'var(--muted)', transform: 'rotate(180deg)' }} />
            <span className="b-src">{s.compareSymbol}</span>
          </span>
        )}
        <span className="lr-sess-title" title={s.title ?? `Session #${s.id}`}>{s.title ?? `Session #${s.id}`}</span>
        <span className="grow" />
        <span className="lr-sess-age">{ago(s.updatedAt)}</span>
        <span className={'lr-sess-st ' + statusKind}>{status}</span>
        <button className="lr-sess-open" onClick={(e) => { e.stopPropagation(); void resumeExisting(s.id) }}>open</button>
        {s.archived ? (
          <button className="lr-sess-open" title="Restore review" onClick={(e) => { e.stopPropagation(); void restoreSession(s.id) }}>restore</button>
        ) : (
          <button className="lr-sess-del" title="Delete review"
            onClick={(e) => {
              e.stopPropagation()
              if (window.confirm('Delete this review? It moves to Archived (recoverable).')) void deleteSession(s.id)
            }}>
            <I.trash style={{ width: 13, height: 13 }} />
          </button>
        )}
      </div>
    )
  }
}
