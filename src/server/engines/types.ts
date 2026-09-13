import type {
  Artifact, CommentAnchor, DiffSkeleton, EngineEvent, EngineId,
  ExecutionMode, FileDiff, ReasoningEffort, ReviewAnnotations
} from '../../shared/types.js'
import type { AgentToolHost } from './tools.js'
import type { ParsedReview, ScopedReviewPatch } from './schema.js'

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
  /** present on an UPDATE pass (drift "Update review"): the existing review to
   *  fold the new commits into, rather than narrating from scratch. */
  prior?: { title: string; summary: string; sections: string[]; sinceSha?: string }
}

/** A diff-scoped update pass: patch the prior iteration's review against a small
 *  since-diff instead of re-narrating the whole branch. Optionally RESUMES the
 *  prior iteration's engine session (near-zero re-reading). The resume→fresh
 *  retry, same-engine guard, and full fallback are orchestrated one layer up —
 *  this method just runs with the resume id when present, fresh when absent. */
export interface ScopedUpdateRequest {
  repo: string
  branch: string
  base: string
  /** the since-diff (drift since the last iteration): changed files WITH hunks;
   *  untracked files synthesized in with `untracked: true`. */
  since: FileDiff[]
  /** the prior iteration's full annotations — the review being patched. */
  prior: ReviewAnnotations
  /** the sha the drift is measured from (last iteration's endSha). */
  sinceSha: string
  /** resume this engine session when set; run fresh (self-contained prompt) when not. */
  priorEngineSessionId?: string
  model?: string
  reasoningEffort?: ReasoningEffort
  /** optional reviewer steer — stays scoped to the drift (one-shot). */
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
  /** when set, the turn gets the limn tool layer (focus/suggest/…). */
  tools?: AgentToolHost
  /** allow code-editing tools this turn (the compare branch is checked out). */
  writeEnabled?: boolean
  /** `message` is the whole prompt (the batch and rebase turns build their own);
   *  otherwise the engine frames it with the review context and the default posture. */
  raw?: boolean
  /** op id for this turn — keys the approval registry (`awaitDecision`). */
  opId?: string
  /** the chat's autonomy tier; the adapter maps it via `AcpEngineConfig.modeFor` /
   *  `ladderPolicy`. */
  executionMode?: ExecutionMode
  /** re-read the thread's tier at each permission request, so moving the mode
   *  selector mid-turn takes effect from the next request on; falls back to
   *  `executionMode` when absent. */
  currentMode?: () => ExecutionMode
  /** Action runs (design board 14 N2): called once the session is open and its
   *  `available_commands_update` has arrived — or `commandsWaitMs` passed without one
   *  (`null`: a resumed Codex session may never send it) — BEFORE the prompt goes
   *  out. A throw refuses the turn: nothing is sent, no tokens are spent. */
  beforePrompt?: (commands: string[] | null) => Promise<void> | void
  /** how long `beforePrompt` waits for the command list (default 2000 ms). */
  commandsWaitMs?: number
}

/** The findings pass after an action run (spec agent-actions-intent §4.3): resume the
 *  run's session and ask for its findings as one JSON list. */
export interface ExtractRequest {
  repo: string
  engineSessionId: string
  model?: string
  reasoningEffort?: ReasoningEffort
  opId?: string
}

/** One finding as the extraction pass reports it (wire shape, validated). */
export interface WireFinding {
  file: string
  line: number
  endLine?: number
  severity: 'risk' | 'note'
  body: string
  suggestion?: string
}

export interface EngineRun<T> {
  events: AsyncIterable<EngineEvent>
  result: Promise<{ value: T; sessionId: string }>
  cancel: () => void
}

export interface ReviewEngine {
  id: EngineId
  generateReview(req: ReviewRequest): EngineRun<ParsedReview>
  /** Diff-scoped update: run a scoped patch turn (structured output =
   *  scopedReviewJsonSchema), resuming `priorEngineSessionId` when present. The
   *  run returns whatever session id the engine yields (Claude mints a new id on
   *  resume-fork; Codex keeps the thread id), same as generateReview. */
  generateScopedUpdate(req: ScopedUpdateRequest): EngineRun<ScopedReviewPatch>
  /** result.sessionId is the engine session id (new when seeded, else resumed).
   *  Tool-enabled turns (incl. the unified batch) flow through here via turn.tools. */
  chat(turn: ChatTurn): EngineRun<string>
  /** The findings pass: structured output on the resumed session, no tools, no edits.
   *  result.sessionId is the session to keep on the thread (Claude forks on resume). */
  extractFindings(req: ExtractRequest): EngineRun<WireFinding[]>
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
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<EngineEvent> => ({
        next: (): Promise<IteratorResult<EngineEvent>> => {
          const ev = this.buffer.shift()
          if (ev) return Promise.resolve({ value: ev, done: false })
          if (this.closed) return Promise.resolve({ value: undefined as never, done: true })
          return new Promise((res) => this.waiters.push(res))
        }
      })
    }
  }
}
