import type { ChatThread, EngineId } from '../../shared/types'
import { engineLabel } from '../../shared/agents'
import { I } from '../kit'
import { useStore, type OpState } from '../store'
import { deltaLabel, latestRun, runBarState } from '../lib/runs'
import { ordinal } from './ChatDrawer'

/** The run bar under the drawer head (design board 14 R1/R3): what is running and
 *  where its findings go, the one place Cancel lives; then the outcome — finished
 *  with its count and duration (Re-run), refused before the prompt (Check again /
 *  Run with the other engine), failed, cancelled — and, while the run waits in the
 *  repo's task queue, its place and what it is behind (Don't wait). */
export function ActionRunBar({ thread, op }: { thread: ChatThread; op: OpState }) {
  const comments = useStore((s) => s.loaded?.state.comments ?? EMPTY)
  const repo = useStore((s) => s.loaded?.state.repo ?? null)
  const cancelOp = useStore((s) => s.cancelOp)
  const runAction = useStore((s) => s.runAction)
  const refreshCommands = useStore((s) => s.refreshCommands)
  const retargetThread = useStore((s) => s.retargetThread)
  const state = runBarState(thread, op, comments)
  const v = latestRun(thread)
  if (!state || !v) return null
  // Re-run is one more turn in THIS thread (a fresh thread is what the bolt launcher does)
  const target = { kind: 'thread' as const, threadId: thread.id }
  const rerun = (): void => { void runAction(v.run.actionId, target) }
  const other: EngineId = thread.agent.engine === 'codex' ? 'claude' : 'codex'
  switch (state.kind) {
    case 'queued':
      return (
        <div className="ax-runbar wait" role="status">
          <span className="limn-spin" />
          <span><b>Queued · {ordinal(state.position)}{state.behind ? `, behind ${state.behind}` : ''}.</b> {v.run.name} starts when the lane frees.</span>
          {op.opId && <button className="btn btn-sm btn-ghost" onClick={() => cancelOp(op.opId!)}>Don’t wait</button>}
        </div>
      )
    case 'running':
      return (
        <div className="ax-runbar" role="status">
          <span className="gen-spinner" />
          <span>Running <b className="mono">{state.spelled}</b> · run {v.run.n}{state.collects ? ' · collects findings' : ''}</span>
          {op.opId && <button className="btn btn-sm btn-ghost" onClick={() => cancelOp(op.opId!)}>Cancel</button>}
        </div>
      )
    case 'finished':
      return (
        <div className="ax-runbar done" role="status">
          <I.check className="ic" />
          <span>
            Finished · run {v.run.n}{state.collects && <> · <b>{state.count === 0 ? 'no findings' : `${state.count} finding${state.count === 1 ? '' : 's'}`}</b></>}{deltaLabel(state.delta) ? ` · ${deltaLabel(state.delta)}` : ''}{state.duration ? ` · ${state.duration}` : ''}
            {state.availabilityFrom && <span className="ax-avail-from" title="The resumed session sent no fresh command list, so the run trusted the last probe"> · availability from {ago(state.availabilityFrom)}</span>}
          </span>
          <button className="btn btn-sm btn-ghost" onClick={rerun} title="Run again — untouched proposals from this run are replaced">Re-run</button>
        </div>
      )
    case 'refused':
      return (
        <div className="ax-runbar err" role="alert">
          <I.x className="ic" />
          <span><b>{state.error.split(' — ')[0]}</b>{state.error.includes(' — ') ? ` — ${state.error.split(' — ').slice(1).join(' — ')}` : ''}</span>
          <button className="btn btn-sm btn-ghost" onClick={() => { if (repo) void refreshCommands(repo, [thread.agent.engine]).then(rerun); else rerun() }}><I.refresh style={{ width: 11, height: 11 }} />Check again</button>
          {!thread.engineSessionId && (
            <button className="btn btn-sm btn-ghost" onClick={() => { void retargetThread(thread.id, { engine: other }).then(() => runAction(v.run.actionId, target)) }}>
              Run with {engineLabel(other)} instead
            </button>
          )}
        </div>
      )
    case 'failed':
      return (
        <div className="ax-runbar err" role="alert">
          <I.x className="ic" />
          <span><b>Run {v.run.n} failed.</b> {state.error}</span>
          <button className="btn btn-sm btn-ghost" onClick={rerun}>Re-run</button>
        </div>
      )
    case 'cancelled':
      return (
        <div className="ax-runbar done" role="status">
          <I.x className="ic" />
          <span>Run {v.run.n} cancelled.</span>
          <button className="btn btn-sm btn-ghost" onClick={rerun}>Re-run</button>
        </div>
      )
  }
}

const EMPTY: never[] = []

function ago(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000))
  if (Number.isNaN(s) || s < 60) return 'just now'
  const m = Math.floor(s / 60)
  return m < 60 ? `${m} min ago` : `${Math.floor(m / 60)} h ago`
}
