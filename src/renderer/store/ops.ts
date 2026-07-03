import type { StateCreator } from 'zustand'
import type { OpErrorCode, OperationStatus } from '../../shared/ipc'
import type { AgentRef, ApprovalDecision, EngineEvent } from '../../shared/types'
import { api } from '../lib/api'
import type { AppStore } from './index'
import { useStore } from './index'
import type { GenState, OpState } from './derive'
import { checkoutGate, anyExclusiveRunning } from './derive'

let opCounter = 0
export function newOpId(): string {
  return `op-${Date.now()}-${++opCounter}`
}

/** A neutral op state — the effective op for a thread/review that owns no in-flight op. */
export const IDLE_GEN: GenState = { running: false, opId: null, kind: null, threadId: null, log: [], error: null, startedAt: null, outcome: null, errorCode: null, answeredApprovals: new Set(), exclusive: false }

/** How many trailing events an op's log retains — bounds per-event re-render cost. */
const LOG_CAP = 200

/** Append `ev` and trim the log to the trailing `LOG_CAP` events, carrying forward any
 *  approval_request the reviewer hasn't answered yet. `pendingApprovals` derives solely
 *  from the log, and status events keep streaming while a request is parked — so a
 *  plainly-trimmed window could evict a pending request and orphan the parked turn. */
function appendCapped(log: EngineEvent[], ev: EngineEvent, answered: Set<string>): EngineEvent[] {
  const grown = [...log, ev]
  if (grown.length <= LOG_CAP) return grown
  const dropped = grown.slice(0, grown.length - LOG_CAP)
  const carried = dropped.filter((e) => e.type === 'approval_request' && !answered.has(e.request.id))
  return [...carried, ...grown.slice(-LOG_CAP)]
}

/** Operation lifecycle: the renderer runs up to two concurrent ops per repo (one
 *  exclusive generate/batch/chat + one read-only shared chat), keyed by opId in `ops`.
 *  Actions take an explicit opId so two live streams never cross-contaminate. */
export interface OpsSlice {
  ops: Record<string, OpState>
  /** start an op. `exclusive` defaults to whether the exclusive lane is currently free
   *  (a chat started on an idle repo takes the exclusive lane; one started under a
   *  running exclusive op is the shared read-only lane). Evicts any prior FINISHED op
   *  on `threadId`; a still-running one is kept so its stream/result keep landing. */
  startOp(kind: 'review' | 'chat', opId: string, threadId?: number, exclusive?: boolean): void
  pushOpEvent(opId: string, ev: EngineEvent): void
  finishOp(opId: string, status: OperationStatus, error?: string, errorCode?: OpErrorCode): void
  /** answer a pending approval for a specific op. */
  respondApproval(opId: string, requestId: string, decision: ApprovalDecision): void
  /** stop a specific op (also auto-denies any parked approvals in main). */
  cancelOp(opId: string): void
}

export const createOpsSlice: StateCreator<AppStore, [], [], OpsSlice> = (set, get) => ({
  ops: {},

  startOp(kind, opId, threadId, exclusive) {
    const isExclusive = exclusive ?? !anyExclusiveRunning(get().ops)
    // per-thread cleanup: drop any prior FINISHED op streaming into this thread. A
    // still-RUNNING op must survive — evicting it would freeze its stream and drop its
    // terminal result (the bridge ignores unknown opIds), and it is reachable: an
    // update-generation reuses the review thread while a shared chat turn streams into
    // it. Per-thread selectors (opForThread) prefer the running op to disambiguate.
    const next: Record<string, OpState> = {}
    for (const [id, op] of Object.entries(get().ops)) if (op.running || op.threadId !== (threadId ?? null)) next[id] = op
    next[opId] = { running: true, opId, kind, threadId: threadId ?? null, log: [], error: null, startedAt: Date.now(), outcome: null, errorCode: null, answeredApprovals: new Set(), exclusive: isExclusive }
    set({ ops: next })
  },

  pushOpEvent(opId, ev) {
    const op = get().ops[opId]
    if (!op || !op.running) return
    set({ ops: { ...get().ops, [opId]: { ...op, log: appendCapped(op.log, ev, op.answeredApprovals) } } })
  },

  finishOp(opId, status, error, errorCode) {
    const op = get().ops[opId]
    if (!op) return
    set({ ops: { ...get().ops, [opId]: { ...op, running: false, outcome: status, error: status === 'failed' ? error ?? 'unknown error' : null, errorCode: status === 'failed' ? errorCode ?? null : null } } })
  },

  respondApproval(opId, requestId, decision) {
    const op = get().ops[opId]
    if (!op) return
    // record the id in the single source of truth BEFORE the IPC call, so every
    // approval surface drops this request from `pendingApprovals` immediately.
    set({ ops: { ...get().ops, [opId]: { ...op, answeredApprovals: new Set(op.answeredApprovals).add(requestId) } } })
    void api().respondApproval(opId, requestId, decision)
  },

  cancelOp(opId) {
    const op = get().ops[opId]
    if (!op) return
    void api().cancel(opId)
    // Record the typed cancel outcome up front and leave the running strip
    // immediately; the main-process terminal result will confirm it later.
    set({ ops: { ...get().ops, [opId]: { ...op, running: false, outcome: 'cancelled', error: null, errorCode: null } } })
  }
})

export async function startGenerate(sessionId: number, agent: AgentRef, opId: string, steer?: string, update?: boolean): Promise<void> {
  const store = useStore.getState()
  // create the review thread (with its opening user turn) and select it BEFORE the
  // agent runs, so generation streams into a real, persisted chat from the first
  // moment — the live stream renders through the normal chat path.
  const threadId = await api().beginReview(sessionId, agent, update, steer)
  await store.reload()              // pull the new review thread into loaded state
  store.switchChat(threadId)        // select it (drawer shows the live stream if open)
  store.startOp('review', opId, threadId, true) // generation always takes the exclusive lane
  void api().generate(sessionId, agent, opId, threadId, steer, update)
}

/** Materialize the (possibly transient) review, then run the agent with the chosen
 *  review agent. The first generate from a transient entry mints the session.
 *  `steer` is an optional one-shot note that focuses the pass; `update` folds new
 *  drift commits into the existing review instead of re-narrating from scratch. */
export async function startGenerateNow(steer?: string, update?: boolean): Promise<void> {
  if (anyExclusiveRunning(useStore.getState().ops)) return // an exclusive op is already in flight
  if (checkoutGate(useStore.getState().loaded).blocked) return
  const sessionId = await useStore.getState().materialize()
  if (sessionId == null) return
  const { loaded, agent } = useStore.getState()
  if (checkoutGate(loaded).blocked) return
  await startGenerate(sessionId, loaded?.state.agent ?? agent, newOpId(), steer?.trim() || undefined, update)
}
