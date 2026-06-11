import { Codex, type Thread, type ThreadEvent } from '@openai/codex-sdk'
import type { Comment, CommentAnchor, EngineEvent, FixResult, ReviewAnnotations } from '../../shared/types.js'
import { EventQueue, type EngineRun, type ReviewEngine, type ReviewRequest } from './types.js'
import { fixJsonSchema, parseFixOutput, parseReviewOutput, reviewJsonSchema } from './schema.js'
import { buildChatPrompt, buildFixPrompt, buildReviewPrompt } from './prompts.js'

function toEvent(ev: ThreadEvent): EngineEvent | null {
  switch (ev.type) {
    case 'turn.started':
      return { type: 'status', text: 'Codex is working…' }
    case 'item.started':
    case 'item.completed': {
      const item = ev.item
      if (item.type === 'command_execution' && ev.type === 'item.started') {
        return { type: 'tool', text: item.command.slice(0, 120) }
      }
      if (item.type === 'reasoning' && ev.type === 'item.completed') {
        return { type: 'status', text: item.text.slice(0, 160) }
      }
      if (item.type === 'agent_message' && ev.type === 'item.completed') {
        return { type: 'text', text: item.text }
      }
      if (item.type === 'file_change' && ev.type === 'item.completed') {
        return { type: 'tool', text: `edit ${item.changes.map((c) => c.path).join(', ')}`.slice(0, 160) }
      }
      if (item.type === 'error') {
        return { type: 'status', text: `note: ${item.message}` }
      }
      return null
    }
    case 'turn.failed':
      return { type: 'error', message: ev.error.message }
    case 'error':
      return { type: 'error', message: ev.message }
    default:
      return null
  }
}

interface TurnOutcome {
  threadId: string
  finalText: string
}

function runTurn(thread: Thread, prompt: string, outputSchema: unknown | undefined, q: EventQueue): { outcome: Promise<TurnOutcome>; abort: AbortController } {
  const abort = new AbortController()
  const outcome = (async (): Promise<TurnOutcome> => {
    let finalText = ''
    let failed: string | null = null
    try {
      const { events } = await thread.runStreamed(prompt, { outputSchema, signal: abort.signal })
      for await (const ev of events) {
        const mapped = toEvent(ev)
        if (mapped) q.push(mapped)
        if (ev.type === 'item.completed' && ev.item.type === 'agent_message') finalText = ev.item.text
        if (ev.type === 'turn.failed') failed = ev.error.message
        if (ev.type === 'error') failed = ev.message
      }
      if (failed) throw new Error(`Codex run failed: ${failed}`)
      q.push({ type: 'done' })
      return { threadId: thread.id ?? '', finalText }
    } catch (err) {
      q.push({ type: 'error', message: err instanceof Error ? err.message : String(err) })
      throw err
    } finally {
      q.close()
    }
  })()
  return { outcome, abort }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    // schema-constrained output occasionally arrives fenced — strip and retry
    const m = text.match(/```(?:json)?\n?([\s\S]*?)```/)
    if (m) return JSON.parse(m[1])
    throw new Error('Codex returned non-JSON output')
  }
}

export class CodexEngine implements ReviewEngine {
  id = 'codex' as const
  private codex = new Codex()

  generateReview(req: ReviewRequest): EngineRun<ReviewAnnotations> {
    const q = new EventQueue()
    q.push({ type: 'status', text: 'Starting Codex…' })
    const thread = this.codex.startThread({
      workingDirectory: req.repo,
      sandboxMode: 'read-only',
      approvalPolicy: 'never'
    })
    const { outcome, abort } = runTurn(thread, buildReviewPrompt(req), reviewJsonSchema, q)
    return {
      events: q.iterable(),
      result: outcome.then(({ threadId, finalText }) => ({
        value: parseReviewOutput(parseJson(finalText)),
        sessionId: threadId
      })),
      cancel: () => abort.abort()
    }
  }

  chat(repo: string, sessionId: string, message: string, anchor?: CommentAnchor): EngineRun<string> {
    const q = new EventQueue()
    const thread = this.codex.resumeThread(sessionId, {
      workingDirectory: repo,
      sandboxMode: 'read-only',
      approvalPolicy: 'never'
    })
    const { outcome, abort } = runTurn(thread, buildChatPrompt(message, anchor), undefined, q)
    return {
      events: q.iterable(),
      result: outcome.then(({ threadId, finalText }) => ({ value: finalText, sessionId: threadId || sessionId })),
      cancel: () => abort.abort()
    }
  }

  applyFeedback(repo: string, sessionId: string, comments: Comment[], steer?: string): EngineRun<FixResult> {
    const q = new EventQueue()
    q.push({ type: 'status', text: 'Codex is applying your comments…' })
    const thread = this.codex.resumeThread(sessionId, {
      workingDirectory: repo,
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never'
    })
    const { outcome, abort } = runTurn(thread, buildFixPrompt(comments, steer), fixJsonSchema, q)
    return {
      events: q.iterable(),
      result: outcome.then(({ threadId, finalText }) => ({
        value: parseFixOutput(parseJson(finalText)),
        sessionId: threadId || sessionId
      })),
      cancel: () => abort.abort()
    }
  }
}
