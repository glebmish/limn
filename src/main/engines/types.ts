import type {
  Artifact, CommentAnchor, DiffSkeleton, EngineEvent, EngineId,
  ExecutionMode, ReasoningEffort, ReviewAnnotations
} from '../../shared/types.js'
import type { AgentToolHost } from './tools.js'

export interface ReviewRequest {
  repo: string
  branch: string
  base: string
  diff: DiffSkeleton
  artifacts: Artifact[]
  model?: string
  reasoningEffort?: ReasoningEffort
  /** optional reviewer steer — focuses this generation pass (one-shot). */
  steer?: string
}

/** Brief review context used to seed a fresh chat session when the chat agent
 *  differs from the review agent (no shared engine session to resume). */
export interface ChatContext { base: string; branch: string; summary?: string }

export interface ChatTurn {
  repo: string
  /** resume this engine session if set; otherwise start a fresh seeded session */
  engineSessionId?: string
  model?: string
  reasoningEffort?: ReasoningEffort
  message: string
  anchor?: CommentAnchor
  context?: ChatContext
  /** when set, the turn gets the localreview tool layer (focus/suggest/…). */
  tools?: AgentToolHost
  /** allow code-editing tools this turn (branch + clean tree preconditions met). */
  writeEnabled?: boolean
  /** op id for this turn — keys the approval registry (`awaitDecision`). */
  opId?: string
  /** the chat's autonomy tier; the adapter maps it via `executionPolicy`. */
  executionMode?: ExecutionMode
}

export interface EngineRun<T> {
  events: AsyncIterable<EngineEvent>
  result: Promise<{ value: T; sessionId: string }>
  cancel: () => void
}

export interface ReviewEngine {
  id: EngineId
  generateReview(req: ReviewRequest): EngineRun<ReviewAnnotations>
  /** result.sessionId is the engine session id (new when seeded, else resumed).
   *  Tool-enabled turns (incl. the unified batch) flow through here via turn.tools. */
  chat(turn: ChatTurn): EngineRun<string>
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
