import { useEffect, useRef, useState } from 'react'
import { checkoutGate, newOpId, useStore } from '../store'
import { I } from '../kit'
import { agentLabel } from '../../shared/agents'
import { reduceToolCalls } from '../../shared/toolcalls'
import { AgentPicker } from './AgentPicker'
import { ToolCallLog } from './ToolCallLog'
import type { AgentRef, ToolCall } from '../../shared/types'

/** mm:ss for the live elapsed counter. */
function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** path-like tokens with a slash + extension, so git refs (`main...x`) and flags
 *  (`--files`) don't get miscounted as files. */
const FILE_RE = /[\w.@~-]*\/[\w./@~-]*\.\w{1,6}/g

/** Files a tool call touched. Structured read/edit tools (Claude) carry a clean
 *  path in `arg`; bash-shelling engines (Codex run everything through bash) need
 *  the paths pulled out of the command string. */
function filesInCall(c: ToolCall): string[] {
  if (c.verb === 'read' || c.verb === 'edit') return c.arg ? [c.arg] : []
  return c.arg?.match(FILE_RE) ?? []
}

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
 *  safely checked out. Checkout itself lives in the Workspace menu (header). */
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
      <b>{branch}</b> isn't checked out — use the Workspace menu to check it out before the agent runs.
    </span>
  )
}

export function GenPanel() {
  const { loaded, gen, agent } = useStore()
  const reviewAgent = loaded?.state.agent ?? agent
  const gate = checkoutGate(loaded)
  const logRef = useRef<HTMLDivElement>(null)
  const [now, setNow] = useState(() => Date.now())

  // keep the latest tool call in view (gen.log is a fresh array each event, so
  // this fires on every event — gen.log.length plateaus at the 200 cap)
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTo({ top: el.scrollHeight })
  }, [gen.log])

  // tick the elapsed counter once a second while an op is running
  useEffect(() => {
    if (!gen.running) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [gen.running])

  if (gen.running) {
    const engineName = reviewAgent.engine === 'codex' ? 'Codex' : 'Claude'
    const verb = gen.kind === 'fix' ? 'is applying your comments' : gen.kind === 'review' ? 'is exploring the branch' : 'is thinking'
    const label = `${engineName} ${verb}…`
    const calls = reduceToolCalls(gen.log)
    const filesExplored = new Set(calls.flatMap(filesInCall)).size
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
        <div className="counts">
          <span><b>{filesExplored}</b> file{filesExplored === 1 ? '' : 's'} explored</span>
          <span><b>{calls.length}</b> tool call{calls.length === 1 ? '' : 's'}</span>
          <span><b>{fmtElapsed(gen.startedAt ? now - gen.startedAt : 0)}</b> elapsed</span>
        </div>
        <div className="gs-log" ref={logRef}>
          <ToolCallLog calls={calls} />
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
