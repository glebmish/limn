import { I, ago, shortSha } from '../kit'
import type { SessionListItem } from '../../shared/types'

/** One session row, rendered by the repo hub's live and archived session lists (its
 *  only caller — the dashboard has its own repo-row markup). */
export function SessionRow({ s, onOpen, onDelete, onRestore, selected, chip }: {
  s: SessionListItem
  onOpen: () => void
  onDelete?: () => void
  onRestore?: () => void
  selected?: boolean
  /** show the compare-branch chip (the hub's flat session list, where rows aren't
   *  grouped under a branch heading). */
  chip?: boolean
}) {
  // merged is the terminal, first-checked status (spec §7): a green badge with the
  // landed sha, rendered in both the live and archived groups.
  const status = s.merged ? `Merged · ${shortSha(s.merged.sha)}`
    : s.approved ? 'approved' : s.unresolved > 0 ? `${s.unresolved} unresolved` : s.hasReview ? 'generated' : 'not generated'
  const statusKind = s.merged ? 'merged' : s.approved ? 'ok' : s.unresolved > 0 ? 'warn' : 'dim'
  const cls = 'limn-sess' + (selected ? ' sel' : '') + (s.archived ? ' archived' : '')
  return (
    <div className={cls} onClick={onOpen} title={s.title ?? `Session #${s.id}`}>
      <span className="limn-sess-id" title={`Session id ${s.id}`}>id: {s.id}</span>
      <span className="limn-sess-title">{s.title ?? `Session #${s.id}`}</span>
      <span className="grow" />
      <span className={'limn-sess-st ' + statusKind}>{status}</span>
      {chip && <span className="limn-chip">{s.compareSymbol}</span>}
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
