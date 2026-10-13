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
  label: string
  /** 1-based place in the repo's task queue while waiting for the lane; null once running */
  position: number | null
  behind: string | null
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
    threadId: number | null; exclusive: boolean; label?: string
  }): void {
    this.ops.set(op.opId, {
      sessionId: op.sessionId,
      kind: op.kind,
      threadId: op.threadId,
      exclusive: op.exclusive,
      label: op.label ?? op.opId,
      position: null,
      behind: null,
      startedAt: new Date().toISOString(),
      events: []
    })
  }

  /** The op's place in its repo's task queue (null = holds the lane / not queued),
   *  and what it is waiting behind — so a (re)joining tab renders the same "Queued ·
   *  2nd, behind …" the live stream announced. No-op for an unknown op. */
  setQueue(opId: string, position: number | null, behind: string | null): void {
    const op = this.ops.get(opId)
    if (op) { op.position = position; op.behind = behind }
  }

  /** ops of a repo's session set — used by the queue broadcaster to find which live
   *  op an opId belongs to. */
  get(opId: string): { sessionId: number; kind: 'review' | 'chat'; threadId: number | null; label: string; position: number | null } | null {
    const op = this.ops.get(opId)
    return op ? { sessionId: op.sessionId, kind: op.kind, threadId: op.threadId, label: op.label, position: op.position } : null
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

  /** Drop every entry — the process is going down (shutdownIpc). Without this a
   *  registry that outlives its server would keep reporting ops nothing is running. */
  clear(): void {
    this.ops.clear()
  }

  /** Snapshots of every op running against `sessionId`. Each carries the trailing
   *  {@link SNAPSHOT_TRAILING_EVENTS} events plus — ahead of that window, in stream
   *  order — any EARLIER `approval_request` still parked, so a tab that joins during
   *  a long-parked approval still renders the card it must answer.
   *
   *  A snapshot NEVER replays an already-answered `approval_request`, wherever it sits
   *  in the stream: the joining renderer adopts the op with an empty `answeredApprovals`
   *  set, so every replayed request reads as pending — an answered one would render a
   *  live, actionable card (and hold the "waiting for approval" strip) for a command
   *  that already ran. Dropping it does not move `nextSeq`: that is the live stream's
   *  watermark, counted over everything recorded, not over what this snapshot replays. */
  forSession(sessionId: number, isPending: IsPending): ActiveOpSnapshot[] {
    const snapshots: ActiveOpSnapshot[] = []
    for (const [opId, op] of this.ops) {
      if (op.sessionId !== sessionId) continue
      const cut = Math.max(0, op.events.length - SNAPSHOT_TRAILING_EVENTS)
      const replayable = (e: EngineEvent): boolean =>
        e.type !== 'approval_request' || isPending(opId, e.request.id)
      // seq = index in the full stream; the replay keeps each event's own seq so a tab
      // catching up after a gap places it by seq, not by its position in this list
      const indexed = op.events.map((e, seq) => ({ e, seq }))
      const picked = [
        ...indexed.slice(0, cut).filter(({ e }) => e.type === 'approval_request' && replayable(e)),
        ...indexed.slice(cut).filter(({ e }) => replayable(e))
      ]
      snapshots.push({
        opId,
        kind: op.kind,
        threadId: op.threadId,
        exclusive: op.exclusive,
        label: op.label,
        ...(op.position != null ? { queued: { position: op.position, behind: op.behind ?? '' } } : {}),
        startedAt: op.startedAt,
        events: picked.map(({ e }) => e),
        seqs: picked.map(({ seq }) => seq),
        nextSeq: op.events.length
      })
    }
    return snapshots
  }
}
