import { I, ago } from '../kit'
import type { SessionListItem } from '../../shared/types'

/** One session row, shared by the dashboard's recent list and the repo hub so the
 *  two stay identical. The dashboard passes `repoName`/`onRepoClick` (it's
 *  cross-repo, so it shows the repo + branch); the hub omits them (rows are
 *  grouped under their branch). */
export function SessionRow({ s, repoName, onRepoClick, onOpen, onDelete, onRestore, active, selected, chip }: {
  s: SessionListItem
  repoName?: string
  onRepoClick?: () => void
  onOpen: () => void
  onDelete?: () => void
  onRestore?: () => void
  active?: boolean
  selected?: boolean
  /** show the compare-branch chip without the cross-repo repo button (the hub's
   *  flat session list, where rows aren't grouped under a branch heading). */
  chip?: boolean
}) {
  const status = s.approved ? 'approved' : s.unresolved > 0 ? `${s.unresolved} unresolved` : s.hasReview ? 'generated' : 'not generated'
  const statusKind = s.approved ? 'ok' : s.unresolved > 0 ? 'warn' : 'dim'
  const cls = 'limn-sess' + (active ? ' active' : '') + (selected ? ' sel' : '') + (s.archived ? ' archived' : '')
  return (
    <div className={cls} onClick={onOpen} title={s.title ?? `Session #${s.id}`}>
      {repoName && (
        <button className="limn-sess-repo" title="All sessions for this repo"
          onClick={(e) => { e.stopPropagation(); onRepoClick?.() }}>{repoName}</button>
      )}
      {repoName && <span className="limn-chip">{s.compareSymbol}</span>}
      <span className="limn-sess-id" title={`Session id ${s.id}`}>id: {s.id}</span>
      <span className="limn-sess-title">{s.title ?? `Session #${s.id}`}</span>
      <span className="grow" />
      <span className={'limn-sess-st ' + statusKind}>{status}</span>
      {chip && !repoName && <span className="limn-chip">{s.compareSymbol}</span>}
      <span className="limn-sess-age">{ago(s.updatedAt)}</span>
      {s.archived
        ? onRestore && <button className="limn-sess-open" title="Restore review" onClick={(e) => { e.stopPropagation(); onRestore() }}>restore</button>
        : onDelete && (
          <button className="limn-sess-del" title="Delete review"
            onClick={(e) => { e.stopPropagation(); if (window.confirm('Delete this review? It moves to Archived (recoverable).')) onDelete() }}>
            <I.trash style={{ width: 13, height: 13 }} />
          </button>
        )}
    </div>
  )
}
