import type { ChatThread } from '../../shared/types'
import { runFindings } from '../../shared/actions'
import { I } from '../kit'
import { useStore } from '../store'
import { focusAnchor, commentJumpTarget } from '../lib/focus'
import { resultCardState, runsOf } from '../lib/runs'

/** The card after a run's last turn (design board 14 R1, v3): how many findings it
 *  proposed with the bulk pair and a jump to the first; "superseded by run N" once a
 *  re-run replaced its untouched proposals; or, for a skill run that ended in prose,
 *  the manual Attach findings follow-up and Keep as prose. */
export function ActionResultCard({ thread, runId, agentText }: { thread: ChatThread; runId: string; agentText: string }) {
  const comments = useStore((s) => s.loaded?.state.comments ?? EMPTY)
  const ops = useStore((s) => s.ops)
  const triage = useStore((s) => s.triageFindings)
  const attach = useStore((s) => s.attachFindings)
  const keepProse = useStore((s) => s.keepProse)
  const v = runsOf(thread).find((r) => r.run.runId === runId)
  if (!v) return null
  const state = resultCardState(v, comments, agentText)
  if (!state) return null
  const busy = Object.values(ops).some((o) => o.running && o.threadId === thread.id)
  if (state.kind === 'superseded') {
    return (
      <div className="ax-result plain" role="status">
        <div className="ax-rh"><I.refresh />Superseded by run {state.by}{state.kept > 0 ? ` · ${state.kept} you took stayed` : ''}</div>
      </div>
    )
  }
  if (state.kind === 'report-only') {
    return (
      <div className="ax-result plain">
        <div className="ax-rh"><I.warn />The report attached nothing to the code</div>
        <div className="ax-ract">
          <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => attach(thread.id, runId)}><I.arrow style={{ width: 12, height: 12 }} />Attach findings</button>
          <a onClick={() => void keepProse(thread.id, runId)}>Keep as prose</a>
        </div>
        <div className="ax-rnote">One more turn in this thread asks the agent to anchor each item with <span className="mono">add_finding</span>. Nothing runs until you press it.</div>
      </div>
    )
  }
  const ids = runFindings(comments, runId).filter((c) => c.status === 'proposed').map((c) => c.id)
  const first = state.first ? commentJumpTarget(state.first) : null
  return (
    <div className="ax-result">
      <div className="ax-rh"><I.check />Run finished · <b>{state.total} finding{state.total === 1 ? '' : 's'}</b>{state.open !== state.total ? ` · ${state.open} still proposed` : ' proposed'}{state.dismissed > 0 ? ` · ${state.dismissed} dismissed` : ''}</div>
      <div className="ax-ract">
        <button className="btn btn-sm btn-primary" disabled={ids.length === 0} onClick={() => void triage(ids, 'accept')}>Accept all{ids.length ? ` ${ids.length}` : ''}</button>
        <button className="btn btn-sm" disabled={ids.length === 0} onClick={() => void triage(ids, 'dismiss')}>Dismiss all</button>
        {first && <a onClick={() => focusAnchor(first)}>Show in diff</a>}
      </div>
      <div className="ax-rnote">Re-running replaces proposals you haven’t touched. Accepted, kept or replied-to ones stay.</div>
    </div>
  )
}

const EMPTY: never[] = []
