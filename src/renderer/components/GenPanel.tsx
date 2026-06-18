import { useEffect, useRef } from 'react'
import { newOpId, useStore } from '../store'
import { I } from '../kit'
import { agentLabel } from '../../shared/agents'
import type { AgentRef } from '../../shared/types'

export function startGenerate(sessionId: number, agent: AgentRef, opId: string): void {
  useStore.getState().startOp('review', opId)
  void window.api.generate(sessionId, agent, opId)
}

/** Pull sessionId + the review agent from the store, guard null, then run.
 *  The agent is chosen on the Compare screen and stored on the session. */
export function startGenerateNow(): void {
  const { sessionId, loaded, agent } = useStore.getState()
  if (sessionId == null) return
  startGenerate(sessionId, loaded?.state.agent ?? agent, newOpId())
}

/** CTA before annotations exist + live progress strip during any agent op. */
export function GenPanel() {
  const { loaded, gen, agent } = useStore()
  const reviewAgent = loaded?.state.agent ?? agent
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [gen.log.length])

  if (gen.running) {
    const label = gen.kind === 'fix' ? 'Agent is applying your comments…' : gen.kind === 'review' ? 'Agent is exploring the branch…' : 'Agent is thinking…'
    return (
      <div className="gen-strip">
        <div className="gs-head">
          <span className="gen-spinner"></span>
          <span className="gs-title">{label}</span>
          <button
            className="btn btn-sm btn-ghost"
            onClick={() => { if (gen.opId) void window.api.cancel(gen.opId); useStore.getState().finishOp('cancelled') }}
          >
            Cancel
          </button>
        </div>
        <div className="gs-log" ref={logRef}>
          {gen.log.filter((e) => e.type === 'status' || e.type === 'tool').map((e, i) => (
            <div key={i} className={'gs-line' + (e.type === 'tool' ? ' tool' : '')}>
              {e.type === 'tool' ? '⌁ ' : '· '}{'text' in e ? e.text : ''}
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (gen.error && gen.error !== 'cancelled') {
    return (
      <div className="gen-strip err">
        <div className="gs-head">
          <I.flag style={{ width: 13, height: 13, color: 'var(--red)' }} />
          <span className="gs-title">Agent run failed: {gen.error}</span>
          <button className="btn btn-sm" onClick={startGenerateNow}>Retry</button>
        </div>
      </div>
    )
  }

  if (!loaded?.state.annotations) {
    return (
      <div className="gen-cta">
        <span className="gc-tx">
          <b>Generate a guided review.</b> The agent explores the repo — callers, tests, history, specs —
          then groups this diff into narrated sections with risk flags.
        </span>
        <span className="gc-agent" title="Chosen on the compare screen">
          <I.spark style={{ width: 11, height: 11, color: 'var(--accent)' }} />{agentLabel(reviewAgent)}
        </span>
        <button className="btn btn-primary" onClick={startGenerateNow}>
          <I.spark style={{ width: 13, height: 13 }} />Generate guided review
        </button>
      </div>
    )
  }

  // review exists — slim regenerate control (fresh pass with the same agent);
  // comments and viewed state survive, narration and agent session are replaced
  return (
    <div className="gen-cta gen-regen">
      <span className="gc-tx dim" style={{ fontSize: 11.5 }}>
        Fresh pass replaces the narration and agent session — your comments and viewed marks stay.
      </span>
      <span className="gc-agent" title="The agent that generated this review">
        <I.spark style={{ width: 11, height: 11, color: 'var(--accent)' }} />{agentLabel(reviewAgent)}
      </span>
      <button className="btn btn-sm" onClick={startGenerateNow}>
        <I.changed style={{ width: 12, height: 12 }} />Regenerate review
      </button>
    </div>
  )
}
