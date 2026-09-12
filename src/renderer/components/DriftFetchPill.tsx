import { useState } from 'react'
import type { DriftSummary } from '../../shared/types'
import { shortSha } from '../kit'

/** Titlebar fetch pill (design: 04-drift-close). The branch moved past the loaded
 *  snapshot — a single pulsing dot sits at HEAD; the counts stay collapsed until
 *  hover (Limn never re-renders under you). On hover: a commit chip and, separately,
 *  a working-tree-edit (pencil) chip — committed vs uncommitted told apart by ICON —
 *  plus the combined +X −Y delta. Click folds it in (reload). */
export function DriftFetchPill({ drift, loadedSha, onPull, open }: { drift: DriftSummary; loadedSha: string; onPull: () => void; open?: boolean }) {
  const [pulling, setPulling] = useState(false)
  const tip =
    `The agent moved the branch while you were reading — `
    + [
      drift.commits ? `${drift.commits} new commit${drift.commits === 1 ? '' : 's'}` : null,
      drift.dirty ? 'uncommitted edits' : null
    ].filter(Boolean).join(' and ')
    + ` (+${drift.add} −${drift.del} since ${shortSha(loadedSha)}), not yet loaded. Click to refresh.`
  return (
    <button
      className={'cm-fetch' + (pulling ? ' pulling gone' : '') + (open ? ' is-open' : '')}
      title={tip}
      aria-label={tip}
      onClick={() => { if (pulling) return; setPulling(true); window.setTimeout(onPull, 240) }}
    >
      <span className="cmf-dot"></span>
      <span className="cmf-rest">
        {drift.commits > 0 && (
          <span className="cmf-chip">
            <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="7" cy="7" r="2.6" /><path d="M.6 7h3.8M9.6 7h3.8" strokeLinecap="round" /></svg>
            {drift.commits}
          </span>
        )}
        {drift.dirty && (
          <span className="cmf-chip" title="uncommitted working-tree edits">
            <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round"><path d="M8.4 2.7l2.9 2.9M2.4 11.6l.7-2.7 5.3-5.3 2 2-5.3 5.3-2.7.7z" /></svg>
          </span>
        )}
        <span className="cmf-delta">+{drift.add} <span className="cmf-del">−{drift.del}</span></span>
      </span>
    </button>
  )
}

/** Muted titlebar pill (spec §6): the branch watcher can no longer read the
 *  repo/branch, so live updates are paused. No action button — a self-healing probe
 *  or a reload clears it. Tooltip carries the git error reason. */
export function WatchPausedPill({ reason }: { reason: string }) {
  const label = 'Live updates paused — branch unavailable'
  return (
    <span className="cm-watch-paused" title={reason} aria-label={`${label}: ${reason}`}>
      {label}
    </span>
  )
}
