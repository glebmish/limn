import { Codex, type CodexOptions, type Thread, type ThreadEvent, type ThreadOptions } from '@openai/codex-sdk'
import type { EngineEvent, ReasoningEffort, ReviewAnnotations } from '../../shared/types.js'
import { EventQueue, type ChatTurn, type EngineRun, type ReviewEngine, type ReviewRequest } from './types.js'
import { parseReviewOutput, reviewJsonSchema } from './schema.js'
import { buildReviewPrompt } from './prompts.js'
import { codexBinaryPath } from './binaries.js'
import { deriveVerb, clampOut } from '../../shared/toolcalls.js'
import { chatViaAppServer } from './codexAppServer.js'

/** Codex tool arguments -> kv pairs for the expanded tool-call row. */
function kvOf(args: unknown): [string, string][] {
  if (!args || typeof args !== 'object') return []
  return Object.entries(args as Record<string, unknown>)
    .filter(([, v]) => typeof v === 'string' || typeof v === 'number')
    .map(([k, v]) => [k, String(v)] as [string, string])
}

/** Per-thread model overrides; undefined model = Codex CLI default. `max` is a
 *  Claude-only effort with no Codex equivalent, so it's dropped here. */
function modelOpts(model?: string, reasoningEffort?: ReasoningEffort): Partial<ThreadOptions> {
  return {
    ...(model ? { model } : {}),
    ...(reasoningEffort && reasoningEffort !== 'max' ? { modelReasoningEffort: reasoningEffort } : {})
  }
}

/** Map a Codex ThreadEvent to our EngineEvent. `structured` marks a turn run with an
 *  output schema (review generation): the agent message body is then the JSON result
 *  payload, so it's captured as the result rather than streamed into the chat as prose. */
export function toEvent(ev: ThreadEvent, structured = false): EngineEvent | null {
  switch (ev.type) {
    case 'turn.started':
      return { type: 'status', text: 'Codex is working…' }
    case 'item.started':
    case 'item.updated':
    case 'item.completed': {
      const item = ev.item
      const done = ev.type === 'item.completed'
      // limn MCP tool calls + native tools: structured ToolCall lifecycle.
      // The AgentActions themselves still flow separately via the host's emit.
      if (item.type === 'mcp_tool_call') {
        if (ev.type === 'item.started') {
          return { type: 'tool', call: { id: item.id, verb: deriveVerb(item.tool), name: item.tool, kv: kvOf(item.arguments), state: 'run' } }
        }
        if (done) {
          if (item.status === 'failed') {
            return { type: 'tool', call: { id: item.id, verb: deriveVerb(item.tool), name: item.tool, state: 'err', out: item.error?.message ?? `${item.tool} failed` } }
          }
          const text = (item.result?.content ?? []).map((b) => ('text' in b ? String((b as { text: unknown }).text) : '')).join('')
          const { out, outMore } = clampOut(text)
          return { type: 'tool', call: { id: item.id, verb: deriveVerb(item.tool), name: item.tool, state: 'ok', ...(out ? { out } : {}), ...(outMore ? { outMore } : {}) } }
        }
        return null
      }
      if (item.type === 'command_execution') {
        const arg = item.command.slice(0, 120)
        if (ev.type === 'item.started') {
          return { type: 'tool', call: { id: item.id, verb: 'bash', name: 'command_execution', arg, state: 'run' } }
        }
        if (done) {
          const { out, outMore } = clampOut(item.aggregated_output ?? '')
          const failed = item.status === 'failed' || (item.exit_code != null && item.exit_code !== 0)
          return { type: 'tool', call: { id: item.id, verb: 'bash', name: 'command_execution', arg, state: failed ? 'err' : 'ok', ...(out ? { out } : {}), ...(outMore ? { outMore } : {}) } }
        }
        return null
      }
      if (item.type === 'file_change' && done) {
        const paths = item.changes.map((c) => c.path)
        return { type: 'tool', call: { id: item.id, verb: 'edit', name: 'file_change', arg: paths.join(', ').slice(0, 120), meta: `${paths.length} file${paths.length === 1 ? '' : 's'}`, state: item.status === 'failed' ? 'err' : 'ok' } }
      }
      if (item.type === 'reasoning' && done) {
        return { type: 'status', text: item.text.slice(0, 160) }
      }
      if (item.type === 'agent_message' && done) {
        // structured turn → the message is the JSON payload, not chat text (don't stream it)
        return structured ? null : { type: 'text', text: item.text }
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
        const mapped = toEvent(ev, Boolean(outputSchema))
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
// requests (incl. our limn MCP tools) instead of `never`, which a guardian /
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
      sandboxMode: 'workspace-write',
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
    return chatViaAppServer(turn)
  }
}
