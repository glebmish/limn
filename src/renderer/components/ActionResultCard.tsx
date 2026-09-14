import type { ChatThread } from '../../shared/types'
import { runFindings } from '../../shared/actions'
import { I } from '../kit'
import { useStore } from '../store'
import { focusAnchor, commentJumpTarget } from '../lib/focus'
import { deltaLabel, resultCardState, runsOf } from '../lib/runs'

/** The receipt after a run's last turn (spec agent-actions-intent §2.6): the findings
 *  it collected with the bulk pair and a jump to the first, and what moved on the
 *  branch; "superseded by run N" (or by a later launch in another thread) once a
 *  re-run replaced its untouched proposals; and,
 *  when the findings pass could not read a report, the manual Attach findings
 *  follow-up and Keep as prose. */
export function ActionResultCard({ thread, runId, agentText }: { thread: ChatThread; runId: string; agentText: string }) {
  const comments = useStore((s) => s.loaded?.state.comments ?? EMPTY)
  const chats = useStore((s) => s.loaded?.state.chats ?? EMPTY)
  const ops = useStore((s) => s.ops)
  const triage = useStore((s) => s.triageFindings)
  const attach = useStore((s) => s.attachFindings)
  const keepProse = useStore((s) => s.keepProse)
  const v = runsOf(thread, chats).find((r) => r.run.runId === runId)
  if (!v) return null
  const state = resultCardState(v, comments, agentText)
  if (!state) return null
  const busy = Object.values(ops).some((o) => o.running && o.threadId === thread.id)
  if (state.kind === 'superseded') {
    return (
      <div className="ax-result plain" role="status">
        <div className="ax-rh"><I.refresh />Superseded by {state.by != null ? `run ${state.by}` : 'a later run in another thread'}{state.kept > 0 ? ` · ${state.kept} you took stayed` : ''}</div>
      </div>
    )
  }
  const ids = runFindings(comments, runId).filter((c) => c.status === 'proposed').map((c) => c.id)
  const first = state.first ? commentJumpTarget(state.first) : null
  const branch = deltaLabel(state.delta)
  const findings = !state.collects ? null
    : state.total === 0 ? 'no findings'
    : `${state.total} finding${state.total === 1 ? '' : 's'}${state.open !== state.total ? ` · ${state.open} still proposed` : ' proposed'}${state.dismissed > 0 ? ` · ${state.dismissed} dismissed` : ''}`
  const line = [findings, branch].filter((s): s is string => Boolean(s)).join(' · ')
  return (
    <div className={'ax-result' + (state.total === 0 ? ' plain' : '')}>
      <div className="ax-rh">{state.attachOffer ? <I.warn /> : <I.check />}Run finished{line ? ' · ' : ''}<b>{line}</b></div>
      {state.total > 0 && (
        <>
          <div className="ax-ract">
            <button className="btn btn-sm btn-primary" disabled={ids.length === 0} onClick={() => void triage(ids, 'accept')}>Accept all{ids.length ? ` ${ids.length}` : ''}</button>
            <button className="btn btn-sm" disabled={ids.length === 0} onClick={() => void triage(ids, 'dismiss')}>Dismiss all</button>
            {first && <a onClick={() => focusAnchor(first)}>Show in diff</a>}
          </div>
          <div className="ax-rnote">Re-running replaces proposals you haven’t touched. Accepted, kept or replied-to ones stay.</div>
        </>
      )}
      {state.attachOffer && (
        <>
          <div className="ax-ract">
            <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => attach(thread.id, runId)}><I.arrow style={{ width: 12, height: 12 }} />Attach findings</button>
            <a onClick={() => void keepProse(thread.id, runId)}>Keep as prose</a>
          </div>
          <div className="ax-rnote">The findings pass could not read this report. One more turn asks the agent to anchor each item with <span className="mono">add_finding</span>. Nothing runs until you press it.</div>
        </>
      )}
    </div>
  )
}

const EMPTY: never[] = []
