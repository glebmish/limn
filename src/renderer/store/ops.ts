import type { StateCreator } from 'zustand'
import type { OpErrorCode, OperationStatus } from '../../shared/ipc'
import type { AgentRef, ApprovalDecision, EngineEvent } from '../../shared/types'
import { api } from '../lib/api'
import type { AppStore } from './index'
import { useStore } from './index'
import type { GenState } from './derive'
import { checkoutGate } from './derive'

let opCounter = 0
export function newOpId(): string {
  return `op-${Date.now()}-${++opCounter}`
}

/** A neutral gen state — the effective op for a review that owns no in-flight op. */
export const IDLE_GEN: GenState = { running: false, opId: null, kind: null, threadId: null, log: [], error: null, startedAt: null, outcome: null, errorCode: null, answeredApprovals: new Set() }

/** Generation / operation lifecycle: the single global `gen` op the renderer runs
 *  (review or chat), plus the actions that start / stream / finish / cancel it. */
export interface OpsSlice {
  gen: GenState
  startOp(kind: 'review' | 'chat', opId: string, threadId?: number): void
  pushOpEvent(ev: EngineEvent): void
  finishOp(status: OperationStatus, error?: string, errorCode?: OpErrorCode): void
  /** answer a pending approval for the running op. */
  respondApproval(requestId: string, decision: ApprovalDecision): void
  /** stop the running op (also auto-denies any parked approvals in main). */
  cancelOp(): void
}

export const createOpsSlice: StateCreator<AppStore, [], [], OpsSlice> = (set, get) => ({
  gen: { running: false, opId: null, kind: null, threadId: null, log: [], error: null, startedAt: null, outcome: null, errorCode: null, answeredApprovals: new Set() },

  startOp(kind, opId, threadId) {
    set({ gen: { running: true, opId, kind, threadId: threadId ?? null, log: [], error: null, startedAt: Date.now(), outcome: null, errorCode: null, answeredApprovals: new Set() } })
  },

  pushOpEvent(ev) {
    const gen = get().gen
    if (!gen.running) return
    set({ gen: { ...gen, log: [...gen.log.slice(-200), ev] } })
  },

  finishOp(status, error, errorCode) {
    const gen = get().gen
    set({ gen: { ...gen, running: false, outcome: status, error: status === 'failed' ? error ?? 'unknown error' : null, errorCode: status === 'failed' ? errorCode ?? null : null } })
  },

  respondApproval(requestId, decision) {
    const gen = get().gen
    // record the id in the single source of truth BEFORE the IPC call, so every
    // approval surface drops this request from `pendingApprovals` immediately.
    set({ gen: { ...gen, answeredApprovals: new Set(gen.answeredApprovals).add(requestId) } })
    if (gen.opId) void api().respondApproval(gen.opId, requestId, decision)
  },

  cancelOp() {
    const gen = get().gen
    if (!gen.opId) return
    void api().cancel(gen.opId)
    // Record the typed cancel outcome up front and leave the running strip
    // immediately; the main-process terminal result will confirm it later.
    set({ gen: { ...gen, running: false, outcome: 'cancelled', error: null, errorCode: null } })
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
  store.startOp('review', opId, threadId)
  void api().generate(sessionId, agent, opId, threadId, steer, update)
}

/** Materialize the (possibly transient) review, then run the agent with the chosen
 *  review agent. The first generate from a transient entry mints the session.
 *  `steer` is an optional one-shot note that focuses the pass; `update` folds new
 *  drift commits into the existing review instead of re-narrating from scratch. */
export async function startGenerateNow(steer?: string, update?: boolean): Promise<void> {
  if (useStore.getState().gen.running) return // an op is already in flight
  if (checkoutGate(useStore.getState().loaded).blocked) return
  const sessionId = await useStore.getState().materialize()
  if (sessionId == null) return
  const { loaded, agent } = useStore.getState()
  if (checkoutGate(loaded).blocked) return
  await startGenerate(sessionId, loaded?.state.agent ?? agent, newOpId(), steer?.trim() || undefined, update)
}
