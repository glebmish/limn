import type { ActiveOpSnapshot } from '../shared/ipc.js'
import type { EngineEvent } from '../shared/types.js'

/** How many trailing events a snapshot replays. A long generation streams thousands
 *  of events; a (re)joining tab only needs the recent tail to render a live-looking
 *  stream, and `nextSeq` tells it exactly where the live stream picks up. */
export const SNAPSHOT_TRAILING_EVENTS = 200

interface LiveOp {
  sessionId: number
  kind: 'review' | 'chat'
  threadId: number | null
  exclusive: boolean
  startedAt: string
  events: EngineEvent[]
}

/** True while `requestId` is still parked for `opId` (see engines/approvals.ts). */
export type IsPending = (opId: string, requestId: string) => boolean

/** In-memory index of the ops running right now, so `loadSession` can hand a
 *  (re)joining tab everything it needs to rejoin a live op instead of showing a
 *  stale idle surface: the op's identity, its lane, and its recent event stream.
 *
 *  Purely a mirror of what main already broadcasts — nothing here is persisted, and
 *  every entry disappears when the op's `op:result` goes out (`end`). */
export class LiveOpRegistry {
  private ops = new Map<string, LiveOp>()

  start(op: {
    opId: string; sessionId: number; kind: 'review' | 'chat'
    threadId: number | null; exclusive: boolean
  }): void {
    this.ops.set(op.opId, {
      sessionId: op.sessionId,
      kind: op.kind,
      threadId: op.threadId,
      exclusive: op.exclusive,
      startedAt: new Date().toISOString(),
      events: []
    })
  }

  /** Append an event to the op's stream; returns the 0-based seq it was assigned —
   *  the number the matching `op:event` broadcast carries. */
  record(opId: string, event: EngineEvent): number {
    const op = this.ops.get(opId)
    if (!op) throw new Error(`live op ${opId} is not registered`)
    op.events.push(event)
    return op.events.length - 1
  }

  /** Correct the lane once main has actually chosen it (a chat turn coerced onto the
   *  shared lane). No-op for an op that never registered / already ended. */
  setLane(opId: string, exclusive: boolean): void {
    const op = this.ops.get(opId)
    if (op) op.exclusive = exclusive
  }

  /** The op is over (its `op:result` is going out). Idempotent. */
  end(opId: string): void {
    this.ops.delete(opId)
  }

  has(opId: string): boolean {
    return this.ops.has(opId)
  }

  /** Snapshots of every op running against `sessionId`. Each carries the trailing
   *  {@link SNAPSHOT_TRAILING_EVENTS} events plus — ahead of that window, in stream
   *  order — any EARLIER `approval_request` still parked, so a tab that joins during
   *  a long-parked approval still renders the card it must answer. */
  forSession(sessionId: number, isPending: IsPending): ActiveOpSnapshot[] {
    const snapshots: ActiveOpSnapshot[] = []
    for (const [opId, op] of this.ops) {
      if (op.sessionId !== sessionId) continue
      const cut = Math.max(0, op.events.length - SNAPSHOT_TRAILING_EVENTS)
      const carried = op.events.slice(0, cut).filter(
        (e) => e.type === 'approval_request' && isPending(opId, e.request.id)
      )
      snapshots.push({
        opId,
        kind: op.kind,
        threadId: op.threadId,
        exclusive: op.exclusive,
        startedAt: op.startedAt,
        events: [...carried, ...op.events.slice(cut)],
        nextSeq: op.events.length
      })
    }
    return snapshots
  }
}
