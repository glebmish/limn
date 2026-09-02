import type { ApprovalDecision, ApprovalRequest, EngineEvent } from '../../shared/types.js'

/** Engine-agnostic approval registry. A turn's adapter parks on `awaitDecision`
 *  (emitting the request to the renderer); the renderer's answer flows back through
 *  the `respondApproval` IPC → `resolveDecision`, which unblocks the parked promise.
 *  No timeout: a request waits until resolved or `clearPending` (cancel / turn end). */

const key = (opId: string, requestId: string): string => `${opId}\0${requestId}`

interface Parked { opId: string; resolve: (d: ApprovalDecision) => void }
const parked = new Map<string, Parked>()

/** Emit the approval request and return a promise that settles when the reviewer
 *  answers (or `clearPending` denies it). */
export function awaitDecision(
  opId: string, request: ApprovalRequest, emit: (e: EngineEvent) => void
): Promise<ApprovalDecision> {
  emit({ type: 'approval_request', request })
  return new Promise<ApprovalDecision>((resolve) => {
    parked.set(key(opId, request.id), { opId, resolve })
  })
}

/** Answer a parked request. Unknown / already-answered keys are no-ops. */
export function resolveDecision(opId: string, requestId: string, decision: ApprovalDecision): void {
  const k = key(opId, requestId)
  const p = parked.get(k)
  if (!p) return
  parked.delete(k)
  p.resolve(decision)
}

/** Deny every request parked under an op (cancel / turn end). Idempotent. */
export function clearPending(opId: string): void {
  for (const [k, p] of parked) {
    if (p.opId === opId) { parked.delete(k); p.resolve('deny') }
  }
}

/** Is this exact request still parked? The live-op registry uses it to decide whether
 *  an approval_request that has fallen out of a snapshot's trailing window still needs
 *  to be replayed to a (re)joining tab (see liveOps.ts). */
export function isPending(opId: string, requestId: string): boolean {
  return parked.has(key(opId, requestId))
}

/** Test/diagnostic: how many requests are currently parked for an op. */
export function pendingCount(opId: string): number {
  let n = 0
  for (const p of parked.values()) if (p.opId === opId) n++
  return n
}
