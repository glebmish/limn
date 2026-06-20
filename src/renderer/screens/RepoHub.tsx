import { useStore } from '../store'
import { I, ago } from '../kit'
import { BranchSwitcher, WorktreeSwitcher } from '../components/RepoSwitchers'

export default function RepoHub() {
  const { repo, repoState, repoSessions, error, backToDashboard, resumeExisting, deleteSession, newReview } = useStore()
  if (!repo) return null
  const repoName = repo.split('/').pop()

  return (
    <div className="lr-hub">
      <div className="wf-titlebar">
        <button className="btn btn-sm btn-ghost" onClick={() => backToDashboard()}>
          <I.arrow style={{ width: 12, height: 12, transform: 'rotate(180deg)' }} />repos
        </button>
        <span className="lr-cmp-repo"><b>{repoName}</b> · {repo}</span>
        <span className="grow" />
      </div>

      <div className="lr-hub-bar">
        <BranchSwitcher />
        <WorktreeSwitcher compareBranch={repoState?.current} />
        <span className="grow" />
        <button className="btn btn-sm btn-primary" onClick={() => void newReview()}>
          <I.plus style={{ width: 12, height: 12 }} />New review
        </button>
      </div>

      {error && <div className="lr-error lr-toast">{error}</div>}

      <div className="lr-hub-scroll">
        <div className="lr-hub-sech">Sessions</div>
        {repoSessions.length === 0 && (
          <div className="lr-empty">No reviews yet for this repo. <b>New review</b> to start one.</div>
        )}
        {repoSessions.map((s) => {
          const onActive = s.compareKind === 'branch' && s.compareSymbol === repoState?.current
          const status = s.approved ? 'approved' : s.unresolved > 0 ? `${s.unresolved} unresolved` : s.hasReview ? 'reviewed' : 'not generated'
          const statusKind = s.approved ? 'ok' : s.unresolved > 0 ? 'warn' : 'dim'
          return (
            <div key={s.id} className={'lr-sess' + (onActive ? ' active' : '')} onClick={() => void resumeExisting(s.id)}>
              <span className={'lr-sess-dot ' + (onActive ? 'on' : '')} />
              <span className="lr-sess-refs">
                <span className="b-src">{s.compareSymbol}</span>
                <I.arrow style={{ width: 11, height: 11, color: 'var(--muted)', transform: 'rotate(180deg)' }} />
                <span className="b-base">{s.baseSymbol}</span>
              </span>
              <span className="lr-sess-title">{s.title ?? `Session #${s.id}`}</span>
              <span className="grow" />
              <span className="lr-sess-age">{ago(s.updatedAt)}</span>
              <span className={'lr-sess-st ' + statusKind}>{status}</span>
              <button className="lr-sess-open" onClick={(e) => { e.stopPropagation(); void resumeExisting(s.id) }}>open</button>
              <button className="lr-sess-del" title="Delete review"
                onClick={(e) => {
                  e.stopPropagation()
                  if (window.confirm('Delete this review? Its comments and chat are removed from the list.')) void deleteSession(s.id)
                }}>
                <I.trash style={{ width: 13, height: 13 }} />
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
