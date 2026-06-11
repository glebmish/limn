import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { Comment, CommentAnchor, EngineEvent, FixResult, ReviewAnnotations } from '../../shared/types.js'
import { EventQueue, type EngineRun, type ReviewEngine, type ReviewRequest } from './types.js'
import { fixJsonSchema, parseFixOutput, parseReviewOutput, reviewJsonSchema } from './schema.js'
import { buildChatPrompt, buildFixPrompt, buildReviewPrompt } from './prompts.js'

const READ_TOOLS = ['Read', 'Grep', 'Glob', 'Bash']
const WRITE_TOOLS = [...READ_TOOLS, 'Edit', 'Write']

interface RunOutcome {
  sessionId: string
  structured: unknown
  text: string
}

function toEvent(msg: SDKMessage): EngineEvent | null {
  if (msg.type === 'assistant') {
    const blocks = msg.message.content
    if (Array.isArray(blocks)) {
      for (const b of blocks) {
        if (b.type === 'tool_use') {
          const input = b.input as Record<string, unknown>
          const detail =
            (input.file_path as string) ?? (input.command as string) ?? (input.pattern as string) ?? ''
          return { type: 'tool', text: `${b.name} ${String(detail).slice(0, 120)}`.trim() }
        }
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          return { type: 'text', text: b.text }
        }
      }
    }
    return null
  }
  if (msg.type === 'system' && msg.subtype === 'init') {
    return { type: 'status', text: 'Agent session started' }
  }
  return null
}

function runQuery(prompt: string, options: Options, q: EventQueue): { outcome: Promise<RunOutcome>; abort: AbortController } {
  const abort = new AbortController()
  const outcome = (async (): Promise<RunOutcome> => {
    let sessionId = ''
    let structured: unknown
    let text = ''
    try {
      for await (const msg of query({ prompt, options: { ...options, abortController: abort } })) {
        if (msg.type === 'system' && msg.subtype === 'init') sessionId = msg.session_id
        const ev = toEvent(msg)
        if (ev) q.push(ev)
        if (msg.type === 'result') {
          sessionId = msg.session_id || sessionId
          if (msg.subtype === 'success') {
            structured = msg.structured_output
            text = msg.result
          } else {
            throw new Error(`Claude run failed: ${msg.subtype}`)
          }
        }
      }
      q.push({ type: 'done' })
      return { sessionId, structured, text }
    } catch (err) {
      q.push({ type: 'error', message: err instanceof Error ? err.message : String(err) })
      throw err
    } finally {
      q.close()
    }
  })()
  return { outcome, abort }
}

export class ClaudeEngine implements ReviewEngine {
  id = 'claude' as const

  generateReview(req: ReviewRequest): EngineRun<ReviewAnnotations> {
    const q = new EventQueue()
    q.push({ type: 'status', text: 'Starting Claude…' })
    const { outcome, abort } = runQuery(
      buildReviewPrompt(req),
      {
        cwd: req.repo,
        allowedTools: READ_TOOLS,
        permissionMode: 'default',
        outputFormat: { type: 'json_schema', schema: reviewJsonSchema as Record<string, unknown> }
      },
      q
    )
    return {
      events: q.iterable(),
      result: outcome.then(({ sessionId, structured }) => ({
        value: parseReviewOutput(structured),
        sessionId
      })),
      cancel: () => abort.abort()
    }
  }

  chat(repo: string, sessionId: string, message: string, anchor?: CommentAnchor): EngineRun<string> {
    const q = new EventQueue()
    const { outcome, abort } = runQuery(
      buildChatPrompt(message, anchor),
      {
        cwd: repo,
        resume: sessionId,
        allowedTools: READ_TOOLS,
        disallowedTools: ['Edit', 'Write'],
        permissionMode: 'default'
      },
      q
    )
    return {
      events: q.iterable(),
      result: outcome.then(({ sessionId: sid, text }) => ({ value: text, sessionId: sid })),
      cancel: () => abort.abort()
    }
  }

  applyFeedback(repo: string, sessionId: string, comments: Comment[], steer?: string): EngineRun<FixResult> {
    const q = new EventQueue()
    q.push({ type: 'status', text: 'Claude is applying your comments…' })
    const { outcome, abort } = runQuery(
      buildFixPrompt(comments, steer),
      {
        cwd: repo,
        resume: sessionId,
        allowedTools: WRITE_TOOLS,
        permissionMode: 'acceptEdits',
        outputFormat: { type: 'json_schema', schema: fixJsonSchema as Record<string, unknown> }
      },
      q
    )
    return {
      events: q.iterable(),
      result: outcome.then(({ sessionId: sid, structured }) => ({
        value: parseFixOutput(structured),
        sessionId: sid
      })),
      cancel: () => abort.abort()
    }
  }
}
