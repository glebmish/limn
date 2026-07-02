import { clearPending } from './engines/approvals.js'
import type { OperationStatus } from '../shared/ipc.js'

export type OperationOutcome<T> =
  | { status: 'succeeded'; value: T }
  | { status: Exclude<OperationStatus, 'succeeded'>; error: unknown }

/** Two lanes per repo (spec: concurrent-chat). `exclusive` = generate / batch / any
 *  write-capable turn (at most one, exactly today's lock). `shared` = a chat turn
 *  forced read-only, allowed to coexist with an exclusive op (at most one). */
export type Lane = 'exclusive' | 'shared'

export class RepoBusyError extends Error {
  readonly lane: Lane
  constructor(lane: Lane = 'exclusive') {
    super(lane === 'shared'
      ? 'Another chat turn is already running for this repository'
      : 'Another agent operation is running for this repository')
    this.name = 'RepoBusyError'
    this.lane = lane
  }
}

interface RepoLanes { exclusive?: string; shared?: string }

interface ActiveOperation {
  repo: string
  cancel?: () => void
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return error.name === 'AbortError' || /\b(?:abort(?:ed)?|cancelled)\b/i.test(error.message)
}

/** Owns operation locking, pre-start cancellation, engine cancellation, and cleanup. */
export class OperationCoordinator {
  private active = new Map<string, ActiveOperation>()
  private repoOwners = new Map<string, RepoLanes>()
  private cancelled = new Set<string>()
  private reviewThreads = new Set<number>()

  /** True only while the EXCLUSIVE lane is held — the watcher-suppression and
   *  write-guard meaning. A read-only shared chat turn does not mark the repo busy. */
  repoBusy(repo: string): boolean {
    return this.repoOwners.get(repo)?.exclusive !== undefined
  }

  private lanesFor(repo: string): RepoLanes {
    let lanes = this.repoOwners.get(repo)
    if (!lanes) { lanes = {}; this.repoOwners.set(repo, lanes) }
    return lanes
  }

  private releaseLane(repo: string, lane: Lane): void {
    const lanes = this.repoOwners.get(repo)
    if (!lanes) return
    delete lanes[lane]
    if (lanes.exclusive === undefined && lanes.shared === undefined) this.repoOwners.delete(repo)
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

  cancel(opId: string): void {
    this.cancelled.add(opId)
    this.active.get(opId)?.cancel?.()
    clearPending(opId)
  }

  /** Exclusive lane: fails iff another exclusive op holds the repo. A running shared
   *  (read-only) op does not block it — there is no working-tree conflict (OQ3). */
  async run<T>(opId: string, repo: string, work: () => Promise<T>): Promise<OperationOutcome<T>> {
    return this.runLane('exclusive', opId, repo, work)
  }

  /** Shared lane: a read-only chat turn that may coexist with an exclusive op.
   *  Fails iff another shared op already holds the repo (cap: one). */
  async runShared<T>(opId: string, repo: string, work: () => Promise<T>): Promise<OperationOutcome<T>> {
    return this.runLane('shared', opId, repo, work)
  }

  private async runLane<T>(lane: Lane, opId: string, repo: string, work: () => Promise<T>): Promise<OperationOutcome<T>> {
    const lanes = this.lanesFor(repo)
    if (lanes[lane] !== undefined) return { status: 'failed', error: new RepoBusyError(lane) }
    lanes[lane] = opId
    this.active.set(opId, { repo })
    try {
      this.throwIfCancelled(opId)
      return { status: 'succeeded', value: await work() }
    } catch (error) {
      return { status: this.cancelled.has(opId) || isAbortError(error) ? 'cancelled' : 'failed', error }
    } finally {
      this.releaseLane(repo, lane)
      this.active.delete(opId)
      this.cancelled.delete(opId)
      clearPending(opId)
    }
  }
}
