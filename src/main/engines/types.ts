import type {
  Artifact, Comment, CommentAnchor, DiffSkeleton, EngineEvent, EngineId, FixResult, ReviewAnnotations
} from '../../shared/types.js'

export interface ReviewRequest {
  repo: string
  branch: string
  base: string
  diff: DiffSkeleton
  artifacts: Artifact[]
}

export interface EngineRun<T> {
  events: AsyncIterable<EngineEvent>
  result: Promise<{ value: T; sessionId: string }>
  cancel: () => void
}

export interface ReviewEngine {
  id: EngineId
  generateReview(req: ReviewRequest): EngineRun<ReviewAnnotations>
  chat(repo: string, sessionId: string, message: string, anchor?: CommentAnchor): EngineRun<string>
  applyFeedback(repo: string, sessionId: string, comments: Comment[], steer?: string): EngineRun<FixResult>
}

/** Async queue bridging push-style SDK callbacks to a pull-style AsyncIterable. */
export class EventQueue {
  private buffer: EngineEvent[] = []
  private waiters: ((v: IteratorResult<EngineEvent>) => void)[] = []
  private closed = false

  push(ev: EngineEvent): void {
    if (this.closed) return
    const w = this.waiters.shift()
    if (w) w({ value: ev, done: false })
    else this.buffer.push(ev)
  }

  close(): void {
    this.closed = true
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true })
  }

  iterable(): AsyncIterable<EngineEvent> {
    const self = this
    return {
      [Symbol.asyncIterator](): AsyncIterator<EngineEvent> {
        return {
          next(): Promise<IteratorResult<EngineEvent>> {
            const ev = self.buffer.shift()
            if (ev) return Promise.resolve({ value: ev, done: false })
            if (self.closed) return Promise.resolve({ value: undefined as never, done: true })
            return new Promise((res) => self.waiters.push(res))
          }
        }
      }
    }
  }
}
