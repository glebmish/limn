import { clearPending } from './engines/approvals.js'
import type { OperationStatus } from '../shared/ipc.js'

export type OperationOutcome<T> =
  | { status: 'succeeded'; value: T }
  | { status: Exclude<OperationStatus, 'succeeded'>; error: unknown }

export class RepoBusyError extends Error {
  constructor() {
    super('Another agent operation is running for this repository')
    this.name = 'RepoBusyError'
  }
}

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
  private repoOwners = new Map<string, string>()
  private cancelled = new Set<string>()
  private reviewThreads = new Set<number>()

  repoBusy(repo: string): boolean {
    return this.repoOwners.has(repo)
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

  async run<T>(opId: string, repo: string, work: () => Promise<T>): Promise<OperationOutcome<T>> {
    if (this.repoOwners.has(repo)) return { status: 'failed', error: new RepoBusyError() }
    this.repoOwners.set(repo, opId)
    this.active.set(opId, { repo })
    try {
      this.throwIfCancelled(opId)
      return { status: 'succeeded', value: await work() }
    } catch (error) {
      return { status: this.cancelled.has(opId) || isAbortError(error) ? 'cancelled' : 'failed', error }
    } finally {
      this.repoOwners.delete(repo)
      this.active.delete(opId)
      this.cancelled.delete(opId)
      clearPending(opId)
    }
  }
}
