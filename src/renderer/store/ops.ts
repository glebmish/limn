import type { StateCreator } from 'zustand'
import type { ActiveOpSnapshot, OpErrorCode, OperationStatus } from '../../shared/ipc'
import type { AgentRef, ApprovalDecision, EngineEvent } from '../../shared/types'
import { api } from '../lib/api'
import type { AppStore } from './index'
import { useStore } from './index'
import { drainOrphans } from './bridge'
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
  /** start an op. `exclusive` defaults to a PREDICTION — whether the exclusive lane is
   *  currently free (a chat started on an idle repo takes the exclusive lane; one
   *  started under a running exclusive op is the shared read-only lane). Main
   *  announces the lane it actually chose on every op:event / op:result envelope,
   *  and `setOpLane` applies the correction. Evicts any prior FINISHED op on
   *  `threadId`; a still-running one is kept so its stream/result keep landing. */
  startOp(kind: 'review' | 'chat', opId: string, threadId?: number, exclusive?: boolean): void
  /** Rejoin the ops a load snapshot reports as still running (another tab's turn, or
   *  a CLI-kicked generation). Registers only ops this tab does NOT already know —
   *  re-adopting one would restart its stream from the snapshot and lose the live log
   *  (and, for a finished one, resurrect it) — then replays each snapshot's events and
   *  drains anything the bridge parked for it while the load was in flight. */
  adoptOps(snaps: ActiveOpSnapshot[]): void
  /** Append a streamed event. `seq` (when the envelope carries one) is checked against
   *  the op's `nextSeq` so an event the adoption snapshot already replayed is dropped
   *  instead of double-logged. */
  pushOpEvent(opId: string, ev: EngineEvent, seq?: number): void
  /** correct the op's lane from main's authoritative announcement (OQ7). */
  setOpLane(opId: string, exclusive: boolean): void
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
    // still-RUNNING op must survive — evicting it would freeze its stream and strand its
    // terminal result (the bridge only parks unknown opIds, and nothing re-adopts an op
    // mid-flight while it is still in this map), and it is reachable: an
    // update-generation reuses the review thread while a shared chat turn streams into
    // it. Per-thread selectors (opForThread) prefer the running op to disambiguate.
    const next: Record<string, OpState> = {}
    for (const [id, op] of Object.entries(get().ops)) if (op.running || op.threadId !== (threadId ?? null)) next[id] = op
    next[opId] = { running: true, opId, kind, threadId: threadId ?? null, log: [], error: null, startedAt: Date.now(), outcome: null, errorCode: null, answeredApprovals: new Set(), exclusive: isExclusive }
    set({ ops: next })
  },

  adoptOps(snaps) {
    // adopt one at a time: each replay/drain reads the map back, and a drained
    // op:result can reload (which re-enters adoptOps) — so never batch a stale copy.
    for (const s of snaps) {
      if (get().ops[s.opId]) continue // already ours (running or finished) — leave it alone
      get().startOp(s.kind, s.opId, s.threadId ?? undefined, s.exclusive)
      const op = get().ops[s.opId]
      // Replay through appendCapped, not a raw assign: `events` is the trailing window
      // PLUS any still-pending approval_request, so it can exceed LOG_CAP and must go
      // through the same carry rule the live path uses. Server guarantee (liveOps
      // forSession): every approval_request in `events` is still PARKED — which is why
      // adopting with an empty `answeredApprovals` set cannot show a stale card.
      let log: EngineEvent[] = []
      for (const ev of s.events) log = appendCapped(log, ev, op.answeredApprovals)
      const startedAt = Date.parse(s.startedAt)
      set({ ops: { ...get().ops, [s.opId]: { ...op, log, nextSeq: s.nextSeq, startedAt: Number.isNaN(startedAt) ? op.startedAt : startedAt } } })
      // now that the op exists, replay whatever raced ahead of this load
      drainOrphans(s.opId)
    }
  },

  pushOpEvent(opId, ev, seq) {
    const op = get().ops[opId]
    if (!op || !op.running) return
    // an event the adoption snapshot already carried — drop it rather than double-log.
    // Never derive the replayed range from the event count: the snapshot's `events` can
    // exceed the window (carried approvals), so `nextSeq` is the only safe watermark.
    if (seq !== undefined && op.nextSeq !== undefined && seq < op.nextSeq) return
    const nextSeq = seq !== undefined ? seq + 1 : op.nextSeq
    set({ ops: { ...get().ops, [opId]: { ...op, log: appendCapped(op.log, ev, op.answeredApprovals), nextSeq } } })
  },

  setOpLane(opId, exclusive) {
    const op = get().ops[opId]
    if (!op || op.exclusive === exclusive) return
    set({ ops: { ...get().ops, [opId]: { ...op, exclusive } } })
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
