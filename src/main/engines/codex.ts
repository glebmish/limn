import { Codex, type CodexOptions, type Thread, type ThreadEvent, type ThreadOptions } from '@openai/codex-sdk'
import type { EngineEvent, ReasoningEffort, ReviewAnnotations } from '../../shared/types.js'
import { EventQueue, type ChatTurn, type EngineRun, type ReviewEngine, type ReviewRequest } from './types.js'
import { parseReviewOutput, reviewJsonSchema } from './schema.js'
import { buildChatPrompt, buildReviewPrompt, buildSeededChatPrompt } from './prompts.js'
import { codexBinaryPath } from './binaries.js'
import { registerCodexTurn } from './codexMcp.js'

/** Per-thread model overrides; undefined model = Codex CLI default. `max` is a
 *  Claude-only effort with no Codex equivalent, so it's dropped here. */
function modelOpts(model?: string, reasoningEffort?: ReasoningEffort): Partial<ThreadOptions> {
  return {
    ...(model ? { model } : {}),
    ...(reasoningEffort && reasoningEffort !== 'max' ? { modelReasoningEffort: reasoningEffort } : {})
  }
}

export function toEvent(ev: ThreadEvent): EngineEvent | null {
  switch (ev.type) {
    case 'turn.started':
      return { type: 'status', text: 'Codex is working…' }
    case 'item.started':
    case 'item.updated':
    case 'item.completed': {
      const item = ev.item
      // localreview MCP tool calls: surface as tool activity (started/in-progress)
      // and report failures; the AgentActions themselves flow via the host's emit.
      if (item.type === 'mcp_tool_call') {
        if (ev.type === 'item.completed' && item.status === 'failed') {
          return { type: 'status', text: `note: ${item.error?.message ?? `${item.tool} failed`}` }
        }
        if (ev.type === 'item.started') return { type: 'tool', text: item.tool }
        return null
      }
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

// The approval policy behind the "Auto" mode preset: the reviewer auto-approves safe
// requests (incl. our localreview MCP tools) instead of `never`, which a guardian /
// auto-approval-review treats as auto-deny.
const AUTO_APPROVAL = 'on-request' as const

export class CodexEngine implements ReviewEngine {
  id = 'codex' as const
  private base: CodexOptions = codexBinaryPath() ? { codexPathOverride: codexBinaryPath() } : {}
  private codex = new Codex(this.base)

  generateReview(req: ReviewRequest): EngineRun<ReviewAnnotations> {
    const q = new EventQueue()
    q.push({ type: 'status', text: 'Starting Codex…' })
    const thread = this.codex.startThread({
      workingDirectory: req.repo,
      sandboxMode: 'read-only',
      approvalPolicy: AUTO_APPROVAL,
      ...modelOpts(req.model, req.reasoningEffort)
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

  chat(turn: ChatTurn): EngineRun<string> {
    const q = new EventQueue()
    const abort = new AbortController()
    const write = Boolean(turn.writeEnabled)
    // a write-enabled (batch) turn carries its own fully-built prompt; a read-only
    // chat turn gets the conversational wrapper.
    const prompt = write
      ? turn.message
      : turn.engineSessionId
        ? buildChatPrompt(turn.message, turn.anchor)
        : buildSeededChatPrompt(turn.context ?? { base: '', branch: '' }, turn.message, turn.anchor)

    const result = (async (): Promise<{ value: string; sessionId: string }> => {
      let release: (() => Promise<void>) | null = null
      try {
        // tool-enabled turns get a per-turn Codex pointed at this turn's localhost
        // MCP server (config is constructor-scoped, so a fresh Codex per turn).
        let codex = this.codex
        if (turn.tools) {
          const mcp = await registerCodexTurn(turn.tools)
          release = mcp.release
          codex = new Codex({ ...this.base, config: { mcp_servers: { localreview: { url: mcp.url } } } })
        }
        const opts: ThreadOptions = {
          workingDirectory: turn.repo,
          sandboxMode: write ? 'workspace-write' : 'read-only',
          approvalPolicy: AUTO_APPROVAL,
          ...modelOpts(turn.model, turn.reasoningEffort)
        }
        const thread = turn.engineSessionId ? codex.resumeThread(turn.engineSessionId, opts) : codex.startThread(opts)
        let finalText = ''
        let failed: string | null = null
        const { events } = await thread.runStreamed(prompt, { signal: abort.signal })
        for await (const ev of events) {
          const mapped = toEvent(ev)
          if (mapped) q.push(mapped)
          if (ev.type === 'item.completed' && ev.item.type === 'agent_message') finalText = ev.item.text
          if (ev.type === 'turn.failed') failed = ev.error.message
          if (ev.type === 'error') failed = ev.message
        }
        if (failed) throw new Error(`Codex run failed: ${failed}`)
        q.push({ type: 'done' })
        return { value: finalText, sessionId: thread.id || turn.engineSessionId || '' }
      } catch (err) {
        q.push({ type: 'error', message: err instanceof Error ? err.message : String(err) })
        throw err
      } finally {
        q.close()
        if (release) await release()
      }
    })()

    return { events: q.iterable(), result, cancel: () => abort.abort() }
  }
}
