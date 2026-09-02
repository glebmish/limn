import type { OpEventMsg, OpResultMsg } from '../../shared/ipc'

/** A push message that arrived for an opId this tab does not know yet. It is almost
 *  always a live event racing the load that would have introduced its op: the server
 *  broadcasts `op:event` the moment the engine emits, while the tab is still awaiting
 *  `loadSession`. Dropping it (the old rule) left a hole in the adopted stream — every
 *  token emitted between the snapshot and the subscription was gone for good. */
export type OrphanEntry =
  | { opId: string; at: number; kind: 'event'; msg: OpEventMsg }
  | { opId: string; at: number; kind: 'result'; msg: OpResultMsg }

/** Hard ceiling on buffered entries ACROSS all ops. The buffer exists for a race
 *  measured in milliseconds, so this only has to cover one op's burst; past it the
 *  oldest entries are evicted so a never-adopted op (another session's stream) can
 *  never grow the tab's memory without bound. */
export const ORPHAN_CAP = 500
/** How long an unclaimed entry is worth keeping. Nothing will adopt an op a minute
 *  after its first event reached us — by then the load that would have introduced it
 *  has long since resolved. */
export const ORPHAN_TTL_MS = 60_000

// Arrival-ordered across ops: a single array keeps "oldest evicted first" and "a
// result replays after the events it followed" true without any per-op bookkeeping.
let buffer: OrphanEntry[] = []

function prune(now: number): void {
  const cutoff = now - ORPHAN_TTL_MS
  if (buffer.some((e) => e.at <= cutoff)) buffer = buffer.filter((e) => e.at > cutoff)
}

/** Park a push message for an op that is not in the store yet. */
export function bufferOrphan(entry: OrphanEntry): void {
  prune(entry.at)
  buffer.push(entry)
  if (buffer.length > ORPHAN_CAP) buffer = buffer.slice(buffer.length - ORPHAN_CAP)
}

/** Remove and return everything buffered for `opId`, oldest first. Taking BEFORE the
 *  caller replays makes the drain re-entrant-safe: replaying a result reloads, and a
 *  reload adopts again — which must find nothing left to drain. */
export function takeOrphans(opId: string): OrphanEntry[] {
  prune(Date.now())
  if (!buffer.some((e) => e.opId === opId)) return []
  const mine = buffer.filter((e) => e.opId === opId)
  buffer = buffer.filter((e) => e.opId !== opId)
  return mine
}

/** Test seam: drop everything so buffered entries can't leak between cases. */
export function clearOrphans(): void {
  buffer = []
}
