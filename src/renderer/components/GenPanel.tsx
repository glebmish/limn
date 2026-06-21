import { useEffect, useRef } from 'react'
import { checkoutGate, newOpId, useStore } from '../store'
import { I } from '../kit'
import { agentLabel } from '../../shared/agents'
import { AgentPicker } from './AgentPicker'
import type { AgentRef } from '../../shared/types'

export function startGenerate(sessionId: number, agent: AgentRef, opId: string): void {
  useStore.getState().startOp('review', opId)
  void window.api.generate(sessionId, agent, opId)
}

/** Materialize the (possibly transient) review, then run the agent with the chosen
 *  review agent. The first generate from a transient entry mints the session. */
export async function startGenerateNow(): Promise<void> {
  const sessionId = await useStore.getState().materialize()
  if (sessionId == null) return
  const { loaded, agent } = useStore.getState()
  startGenerate(sessionId, loaded?.state.agent ?? agent, newOpId())
}

/** CTA before annotations exist + live progress strip during any agent op. */
/** Blocked / dirty banner shown in the generate CTA when the compare branch isn't
 *  safely checked out. Checkout itself lives in the worktree menu (header). */
function GateNote({ branch, dirty }: { branch: string | null; dirty?: boolean }) {
  if (dirty) {
    return (
      <span className="gc-gate warn">
        <I.warn style={{ width: 12, height: 12, color: 'var(--amber)' }} />
        Uncommitted changes in the worktree — agent edits will mix with them.
      </span>
    )
  }
  return (
    <span className="gc-gate block">
      <I.warn style={{ width: 12, height: 12, color: 'var(--amber)' }} />
      <b>{branch}</b> isn't checked out — use the worktree menu to check it out before the agent runs.
    </span>
  )
}

export function GenPanel() {
  const { loaded, gen, agent } = useStore()
  const reviewAgent = loaded?.state.agent ?? agent
  const gate = checkoutGate(loaded)
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
            <div key={i} className={'gs-line' + (e.type === 'tool' ? ' tool' : '')}
              title={'text' in e ? e.text : undefined}>
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
        <AgentPicker value={reviewAgent} onChange={(a) => useStore.getState().setAgent(a)} />
        <button className="btn btn-primary" disabled={gate.blocked} onClick={startGenerateNow}>
          <I.spark style={{ width: 13, height: 13 }} />Generate guided review
        </button>
        {gate.blocked && <GateNote branch={gate.branch} />}
        {gate.dirtyWarn && <GateNote branch={gate.branch} dirty />}
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
      <button className="btn btn-sm" disabled={gate.blocked} onClick={startGenerateNow}>
        <I.changed style={{ width: 12, height: 12 }} />Regenerate review
      </button>
      {gate.blocked && <GateNote branch={gate.branch} />}
    </div>
  )
}
