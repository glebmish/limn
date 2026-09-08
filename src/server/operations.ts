import { clearPending } from './engines/approvals.js'
import { isCancellation } from './engines/errors.js'
import type { OperationStatus } from '../shared/ipc.js'

export type OperationOutcome<T> =
  | { status: 'succeeded'; value: T }
  | { status: Exclude<OperationStatus, 'succeeded'>; error: unknown }

/** A send targeted a chat thread that already has a turn in flight (a second client —
 *  web serve / second window — racing the first). Rejected fast, per thread, so two
 *  turns can never interleave persisted messages or race the thread's engine-session
 *  binding. */
export class ThreadBusyError extends Error {
  constructor() {
    super('A turn is already running in this chat — wait for it to finish')
    this.name = 'ThreadBusyError'
  }
}

/** A task's public identity while it holds the lane or waits for it. */
export interface QueuedOp { opId: string; label: string }

interface ActiveOperation {
  repo: string
  cancel?: () => void
}

interface Waiter extends QueuedOp {
  /** resolves true when the lane is granted, false when cancelled while waiting */
  grant: (ok: boolean) => void
}

/** Owns the per-repo task queue, pre-start cancellation, engine cancellation, and
 *  cleanup. ONE lane per repo (design board 14 v3, "a single queue of tasks"): a
 *  generation, an action run, a chat turn, a batch, a merge — every agent-shaped
 *  task takes the repo in the order it was asked for, and the ones behind it wait
 *  visibly (`queued`/`holder` feed the run bar and the Chat pill) instead of being
 *  refused or coerced read-only. */
export class OperationCoordinator {
  private active = new Map<string, ActiveOperation>()
  private holders = new Map<string, QueuedOp>()
  private queues = new Map<string, Waiter[]>()
  private listeners = new Set<(repo: string) => void>()
  private cancelled = new Set<string>()
  private reviewThreads = new Set<number>()

  /** True while some task holds the repo's lane — the watcher-suppression and
   *  write-guard meaning. A waiting task does not mark the repo busy. */
  repoBusy(repo: string): boolean {
    return this.holders.has(repo)
  }

  /** The task holding the lane right now, if any. */
  holder(repo: string): QueuedOp | null {
    return this.holders.get(repo) ?? null
  }

  /** The tasks waiting for the lane, first in line first. */
  queued(repo: string): QueuedOp[] {
    return (this.queues.get(repo) ?? []).map(({ opId, label }) => ({ opId, label }))
  }

  /** Fires after every change to a repo's holder or queue. Returns the unsubscribe. */
  onQueueChange(cb: (repo: string) => void): () => void {
    this.listeners.add(cb)
    return () => { this.listeners.delete(cb) }
  }

  private notify(repo: string): void {
    for (const cb of this.listeners) cb(repo)
  }

  markReviewThread(threadId: number): void {
    this.reviewThreads.add(threadId)
  }

  unmarkReviewThread(threadId: number): void {
    this.reviewThreads.delete(threadId)
  }

  activeReviewThreadIds(): ReadonlySet<number> {
    return this.reviewThreads
  }

  throwIfCancelled(opId: string): void {
    if (this.cancelled.has(opId)) throw new DOMException('cancelled', 'AbortError')
  }

  registerCancel(opId: string, cancel: () => void): void {
    const op = this.active.get(opId)
    if (!op) throw new Error(`operation ${opId} is not active`)
    op.cancel = cancel
    if (this.cancelled.has(opId)) cancel()
  }

  /** Cancel a task wherever it is: still waiting (it leaves the queue and settles
   *  `cancelled` without running), running (its engine cancel fires), or not started
   *  yet (it settles `cancelled` the moment `run` is called). */
  cancel(opId: string): void {
    this.cancelled.add(opId)
    for (const [repo, waiters] of this.queues) {
      const i = waiters.findIndex((w) => w.opId === opId)
      if (i === -1) continue
      const [w] = waiters.splice(i, 1)
      if (waiters.length === 0) this.queues.delete(repo)
      w.grant(false)
      this.notify(repo)
    }
    this.active.get(opId)?.cancel?.()
    clearPending(opId)
  }

  /** Take the repo's lane — waiting in line if another task holds it — run `work`,
   *  and hand the lane to the next in line. `label` is what the tasks behind this one
   *  are told they are waiting for. */
  async run<T>(opId: string, repo: string, work: () => Promise<T>, meta: { label?: string } = {}): Promise<OperationOutcome<T>> {
    const label = meta.label ?? opId
    if (this.cancelled.has(opId)) {
      this.cancelled.delete(opId)
      clearPending(opId)
      return { status: 'cancelled', error: new DOMException('cancelled', 'AbortError') }
    }
    if (this.holders.has(repo)) {
      const granted = await new Promise<boolean>((grant) => {
        const waiters = this.queues.get(repo) ?? []
        waiters.push({ opId, label, grant })
        this.queues.set(repo, waiters)
        this.notify(repo)
      })
      if (!granted) {
        this.cancelled.delete(opId)
        clearPending(opId)
        return { status: 'cancelled', error: new DOMException('cancelled', 'AbortError') }
      }
    } else {
      this.holders.set(repo, { opId, label })
      this.notify(repo)
    }
    this.active.set(opId, { repo })
    try {
      this.throwIfCancelled(opId)
      return { status: 'succeeded', value: await work() }
    } catch (error) {
      return { status: this.cancelled.has(opId) || isCancellation(error) ? 'cancelled' : 'failed', error }
    } finally {
      this.active.delete(opId)
      this.cancelled.delete(opId)
      clearPending(opId)
      this.release(repo)
    }
  }

  /** Hand the lane to the first waiter, or free it. The waiter becomes the holder
   *  BEFORE its promise resumes, so no gap exists in which the lane reads as free. */
  private release(repo: string): void {
    const waiters = this.queues.get(repo)
    const next = waiters?.shift()
    if (waiters && waiters.length === 0) this.queues.delete(repo)
    if (next) {
      this.holders.set(repo, { opId: next.opId, label: next.label })
      this.notify(repo)
      next.grant(true)
    } else {
      this.holders.delete(repo)
      this.notify(repo)
    }
  }
}
