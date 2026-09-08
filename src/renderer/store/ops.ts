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
export const IDLE_GEN: GenState = { running: false, opId: null, kind: null, threadId: null, log: [], error: null, startedAt: null, outcome: null, errorCode: null, answeredApprovals: new Set(), exclusive: false, queued: null }

/** The op-surface state every review entry point drops before showing another review:
 *  a previous session's running/errored op must not bleed its strip, its error banner,
 *  its exclusive-lane block or its parked follow-up onto the review being opened.
 *  Spread by all three entry points (openReview's transient path, resumeExisting,
 *  backToDashboard) so a future field can't be remembered in only some of them.
 *  Safe to share: nothing ever mutates either map in place — every write builds a new
 *  object. `resumeExisting` re-adopts whatever is live on the session it opened AFTER
 *  spreading this. */
export const RESET_REVIEW_SURFACE: Pick<AppStore, 'ops' | 'queuedTurnByThread' | 'seenThreadAt'> = Object.freeze({
  ops: Object.freeze({}) as Record<string, OpState>,
  queuedTurnByThread: Object.freeze({}) as Record<number, string>,
  seenThreadAt: Object.freeze({}) as Record<number, string>
})

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
  /** start an op. Every op takes the repo's single lane (queueing server-side when
   *  another holds it), so `exclusive` defaults to true; main still announces the
   *  lane on every op:event / op:result envelope and `setOpLane` applies it. Evicts
   *  any prior FINISHED op on `threadId`; a still-running one is kept so its
   *  stream/result keep landing. */
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
    const isExclusive = exclusive ?? true
    // per-thread cleanup: drop any prior FINISHED op streaming into this thread. A
    // still-RUNNING op must survive — evicting it would freeze its stream and strand its
    // terminal result (the bridge only parks unknown opIds, and nothing re-adopts an op
    // mid-flight while it is still in this map), and it is reachable: an
    // update-generation reuses the review thread while a shared chat turn streams into
    // it. Per-thread selectors (opForThread) prefer the running op to disambiguate.
    const next: Record<string, OpState> = {}
    for (const [id, op] of Object.entries(get().ops)) if (op.running || op.threadId !== (threadId ?? null)) next[id] = op
    next[opId] = { running: true, opId, kind, threadId: threadId ?? null, log: [], error: null, startedAt: Date.now(), outcome: null, errorCode: null, answeredApprovals: new Set(), exclusive: isExclusive, queued: null }
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
      set({ ops: { ...get().ops, [s.opId]: { ...op, log, nextSeq: s.nextSeq, startedAt: Number.isNaN(startedAt) ? op.startedAt : startedAt, queued: s.queued ?? null } } })
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
    // a lane event moves the op between "waiting in the queue" and "holding the lane"
    const queued = ev.type === 'lane' ? (ev.state === 'queued' ? { position: ev.position ?? 1, behind: ev.behind ?? '' } : null) : op.queued
    set({ ops: { ...get().ops, [opId]: { ...op, log: appendCapped(op.log, ev, op.answeredApprovals), nextSeq, queued } } })
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
    // …and reconcile the optimism if the call never lands. The approval registry has
    // no timeout, so a dropped decision parks the agent forever with no card left to
    // click: put the request back and say why, so the reviewer can answer again.
    // Promise.resolve wraps the call because respondApproval is fire-and-forget at
    // several stubs/call sites and need not return a promise.
    Promise.resolve(api().respondApproval(opId, requestId, decision)).catch((err: unknown) => {
      const current = get().ops[opId]
      const answered = new Set(current?.answeredApprovals ?? [])
      answered.delete(requestId)
      set({
        error: err instanceof Error ? err.message : String(err),
        ...(current ? { ops: { ...get().ops, [opId]: { ...current, answeredApprovals: answered } } } : {})
      })
    })
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
  try {
    // create the review thread (with its opening user turn) and select it BEFORE the
    // agent runs, so generation streams into a real, persisted chat from the first
    // moment — the live stream renders through the normal chat path.
    const threadId = await api().beginReview(sessionId, agent, update, steer)
    await store.reload()              // pull the new review thread into loaded state
    store.switchChat(threadId)        // select it (drawer shows the live stream if open)
    store.startOp('review', opId, threadId, true) // generation always takes the exclusive lane
    // Fire-and-forget, but never silently: the server runs its generate preflight
    // BEFORE registering the op, so a rejection here means no op:result will ever
    // arrive. Retire the op ourselves or the strip spins forever and the exclusive
    // lane stays blocked for every other generate/batch/rebase.
    Promise.resolve(api().generate(sessionId, agent, opId, threadId, steer, update)).catch((err: unknown) => {
      useStore.getState().finishOp(opId, 'failed', err instanceof Error ? err.message : String(err))
    })
  } catch (err) {
    // every sibling lifecycle action reports through the error strip; the generate
    // entry path used to swallow a failed beginReview as a dead button click.
    useStore.setState({ error: err instanceof Error ? err.message : String(err) })
  }
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
