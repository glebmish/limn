import { createSdkMcpServer, query, tool, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { EngineEvent, ReasoningEffort, ReviewAnnotations } from '../../shared/types.js'
import { EventQueue, type ChatTurn, type EngineRun, type ReviewEngine, type ReviewRequest } from './types.js'
import { parseReviewOutput, reviewJsonSchema } from './schema.js'
import { buildChatPrompt, buildReviewPrompt, buildSeededChatPrompt } from './prompts.js'
import { claudeBinaryPath } from './binaries.js'
import { LR_TOOLS, lrAllowedToolNames, type AgentToolHost } from './tools.js'
import { deriveVerb, clampOut } from '../../shared/toolcalls.js'

const READ_TOOLS = ['Read', 'Grep', 'Glob', 'Bash']
const WRITE_TOOLS = [...READ_TOOLS, 'Edit', 'Write']

/** Host the engine-agnostic LR_TOOLS as an in-process MCP server bound to this
 *  turn's tool host. The handler runs in main: it performs the side effect, emits
 *  the live action event, and returns the text the model sees. */
function localReviewMcp(host: AgentToolHost, writeEnabled: boolean): Pick<Options, 'mcpServers' | 'allowedTools'> {
  const tools = LR_TOOLS.map((td) =>
    tool(td.name, td.description, td.input, async (args) => {
      const { result, isError } = await host.call(td.name, args)
      return { content: [{ type: 'text' as const, text: result }], isError }
    })
  )
  return {
    mcpServers: { localreview: createSdkMcpServer({ name: 'localreview', tools }) },
    allowedTools: lrAllowedToolNames(writeEnabled)
  }
}

interface RunOutcome {
  sessionId: string
  structured: unknown
  text: string
}

/** Primary display arg + the structured kv pairs for a tool_use input. */
function primaryArg(input: Record<string, unknown>): { arg?: string; kv: [string, string][] } {
  const kv = Object.entries(input)
    .filter(([, v]) => typeof v === 'string' || typeof v === 'number')
    .map(([k, v]) => [k, String(v)] as [string, string])
  const raw = input.file_path ?? input.path ?? input.pattern ?? input.command ?? input.query
  return { arg: raw != null ? String(raw) : undefined, kv }
}

/** Flatten a tool_result block's content (string or content-block array) to text. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : ''))
      .join('')
  }
  return ''
}

/** Map one SDK message to zero or more EngineEvents. A single assistant message
 *  can carry several content blocks (text + multiple tool_use); tool results
 *  arrive on subsequent `user` messages and settle the matching running call by id. */
export function toEvents(msg: SDKMessage): EngineEvent[] {
  const out: EngineEvent[] = []
  if (msg.type === 'assistant') {
    const blocks = msg.message.content
    if (Array.isArray(blocks)) {
      for (const b of blocks) {
        if (b.type === 'tool_use') {
          const { arg, kv } = primaryArg(b.input as Record<string, unknown>)
          out.push({ type: 'tool', call: { id: b.id, verb: deriveVerb(b.name), name: b.name, ...(arg ? { arg } : {}), ...(kv.length ? { kv } : {}), state: 'run' } })
        } else if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          out.push({ type: 'text', text: b.text })
        }
      }
    }
    return out
  }
  if (msg.type === 'user') {
    const blocks = (msg.message as { content?: unknown }).content
    if (Array.isArray(blocks)) {
      for (const b of blocks as { type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean }[]) {
        if (b.type === 'tool_result' && b.tool_use_id) {
          const { out: clamped, outMore } = clampOut(resultText(b.content))
          out.push({ type: 'tool', call: { id: b.tool_use_id, verb: 'other', name: '', state: b.is_error ? 'err' : 'ok', ...(clamped ? { out: clamped } : {}), ...(outMore ? { outMore } : {}) } })
        }
      }
    }
    return out
  }
  if (msg.type === 'system' && msg.subtype === 'init') return [{ type: 'status', text: 'Agent session started' }]
  return out
}

function runQuery(prompt: string, options: Options, q: EventQueue): { outcome: Promise<RunOutcome>; abort: AbortController } {
  const abort = new AbortController()
  const outcome = (async (): Promise<RunOutcome> => {
    let sessionId = ''
    let structured: unknown
    let text = ''
    try {
      const pathToClaudeCodeExecutable = claudeBinaryPath()
      console.error(`[claude-engine] executable: ${pathToClaudeCodeExecutable ?? 'SDK default'}`)
      for await (const msg of query({
        prompt,
        options: { ...options, abortController: abort, ...(pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable } : {}) }
      })) {
        if (msg.type === 'system' && msg.subtype === 'init') sessionId = msg.session_id
        for (const ev of toEvents(msg)) q.push(ev)
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
        ...modelOpt(req.model, req.reasoningEffort),
        allowedTools: READ_TOOLS,
        permissionMode: 'auto',
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

  chat(turn: ChatTurn): EngineRun<string> {
    const q = new EventQueue()
    const write = Boolean(turn.writeEnabled)
    // a write-enabled (batch) turn carries its own fully-built prompt (buildBatchPrompt);
    // a read-only chat turn gets the conversational wrapper.
    const prompt = write
      ? turn.message
      : turn.engineSessionId
        ? buildChatPrompt(turn.message, turn.anchor)
        : buildSeededChatPrompt(turn.context ?? { base: '', branch: '' }, turn.message, turn.anchor)
    const lr = turn.tools ? localReviewMcp(turn.tools, write) : undefined
    const { outcome, abort } = runQuery(
      prompt,
      {
        cwd: turn.repo,
        ...(turn.engineSessionId ? { resume: turn.engineSessionId } : {}),
        ...modelOpt(turn.model, turn.reasoningEffort),
        allowedTools: [...(write ? WRITE_TOOLS : READ_TOOLS), ...(lr?.allowedTools ?? [])],
        permissionMode: 'auto',
        ...(write ? {} : { disallowedTools: ['Edit', 'Write'] }),
        ...(lr ? { mcpServers: lr.mcpServers } : {})
      },
      q
    )
    return {
      events: q.iterable(),
      result: outcome.then(({ sessionId: sid, text }) => ({ value: text, sessionId: sid })),
      cancel: () => abort.abort()
    }
  }
}

/** Claude's model is a plain string option; undefined = CLI default. The agent
 *  SDK's `effort` option spans low→max — pass it through when set. `minimal`
 *  (Codex-only) has no Claude equivalent, so it's dropped. */
function modelOpt(model?: string, effort?: ReasoningEffort): Partial<Options> {
  const opt: Partial<Options> = {}
  if (model) opt.model = model
  if (effort && effort !== 'minimal') opt.effort = effort
  return opt
}
