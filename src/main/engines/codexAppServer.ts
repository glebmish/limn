import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import type { ApprovalDecision, ApprovalRequest, EngineEvent, ExecutionMode, ReasoningEffort } from '../../shared/types.js'
import { executionPolicy, DEFAULT_EXECUTION_MODE } from '../../shared/executionMode.js'
import { awaitDecision } from './approvals.js'
import { codexBinaryPath } from './binaries.js'
import { EventQueue, type ChatTurn, type EngineRun } from './types.js'
import { registerCodexTurn } from './codexMcp.js'
import { buildChatPrompt, buildSeededChatPrompt } from './prompts.js'
import { deriveVerb, clampOut } from '../../shared/toolcalls.js'

/**
 * Hand-written `codex app-server` JSON-RPC-over-stdio client. This is the single
 * Codex chat path because it can answer approval server-requests and route them
 * through Limn's reviewer approval UI.
 *
 * The exact method/param names are pinned from `codex app-server generate-ts`
 * output where noted. The pure helpers below (framing, routing, decision/policy
 * mapping, notification→event) are unit-tested.
 */

// ── pure helpers (unit-tested) ────────────────────────────────

/** Outgoing frame: compact JSON + newline (NDJSON, not Content-Length). */
export function encodeFrame(msg: unknown): string {
  return JSON.stringify(msg) + '\n'
}

/** Split a stdout chunk on newlines, parse complete lines, return the trailing
 *  partial line so the caller can prepend it to the next chunk. */
export function decodeChunk(buffer: string): { messages: unknown[]; rest: string } {
  const parts = buffer.split('\n')
  const rest = parts.pop() ?? ''
  const messages: unknown[] = []
  for (const raw of parts) {
    const line = raw.replace(/\r$/, '').trim()
    if (!line) continue
    try { messages.push(JSON.parse(line)) } catch { /* skip non-JSON diagnostic lines */ }
  }
  return { messages, rest }
}

export type FrameKind = 'request' | 'notification' | 'response' | 'unknown'

/** Classify an incoming message by shape (no envelope tag): method+id = a
 *  server→client request we must answer; method without id = a notification;
 *  id with result|error = a response to one of our requests. */
export function classifyMessage(msg: unknown): FrameKind {
  if (!msg || typeof msg !== 'object') return 'unknown'
  const m = msg as Record<string, unknown>
  const hasMethod = typeof m.method === 'string'
  const hasId = m.id !== undefined && m.id !== null
  if (hasMethod && hasId) return 'request'
  if (hasMethod) return 'notification'
  if (hasId && ('result' in m || 'error' in m)) return 'response'
  return 'unknown'
}

/** The server→client approval requests we answer (verified against `codex
 *  app-server generate-ts`, 0.139.0): the v2 `item/.../requestApproval` pair.
 *  Everything else (requestUserInput, elicitation, item/permissions/requestApproval,
 *  item/tool/call) is an unsupported surface we auto-deny so the turn never wedges. */
const APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
])
export function isApprovalMethod(method: string): boolean {
  return APPROVAL_METHODS.has(method)
}

/** Map our decision to the v2 app-server's approval result value
 *  (`CommandExecutionApprovalDecision` / `FileChangeApprovalDecision`, both
 *  `accept | decline | …`; verified against generate-ts, 0.139.0). */
export function mapApprovalDecision(decision: ApprovalDecision): 'accept' | 'decline' {
  return decision === 'allow' ? 'accept' : 'decline'
}

/** AskForApproval value for a tier (executionPolicy is the source of truth). */
export function approvalPolicyFor(mode: ExecutionMode): string {
  return executionPolicy(mode).codexApprovalPolicy
}

/** Rich SandboxPolicy object TurnStartParams expects, derived from the tier +
 *  the write guard (workspace-write only when the turn may edit). */
export function sandboxPolicyFor(mode: ExecutionMode, repo: string, writeEnabled: boolean): Record<string, unknown> {
  const sandbox = executionPolicy(mode).codexSandbox
  if (sandbox === 'danger-full-access') return { type: 'dangerFullAccess' }
  if (sandbox === 'workspace-write' && writeEnabled) {
    return { type: 'workspaceWrite', writableRoots: [repo], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
  }
  return { type: 'readOnly', networkAccess: false }
}

/** Build an ApprovalRequest from a v2 app-server approval server-request's params
 *  (verified against generate-ts, 0.139.0). `item/commandExecution/requestApproval`
 *  carries `command: string` + `cwd`; `item/fileChange/requestApproval` carries only
 *  `itemId`/`reason` (no file list), so a patch approval shows its reason. */
export function approvalRequestFromParams(id: string, params: unknown): ApprovalRequest {
  const p = (params && typeof params === 'object' ? params : {}) as Record<string, unknown>
  const command = typeof p.command === 'string' ? p.command : undefined
  const cwd = typeof p.cwd === 'string' ? p.cwd : undefined
  const reason = typeof p.reason === 'string' ? p.reason : undefined
  if (command) return { id, engine: 'codex', kind: 'command', summary: `Run \`${command}\``, detail: { command, ...(cwd ? { cwd } : {}), ...(reason ? { reason } : {}) } }
  return { id, engine: 'codex', kind: 'file_change', summary: reason ?? 'Apply file changes', detail: { ...(reason ? { reason } : {}) } }
}

/** Map an app-server notification to an EngineEvent (keyed by method, per the
 *  verified protocol). Text streams as `item/agentMessage/delta`; reasoning as
 *  the reasoning delta notifications. Returns null to ignore. */
export function appServerNotifToEvent(method: string, params: unknown): EngineEvent | null {
  const p = (params && typeof params === 'object' ? params : {}) as Record<string, unknown>
  if (method === 'item/agentMessage/delta') {
    return typeof p.delta === 'string' ? { type: 'text', text: p.delta } : null
  }
  if (method === 'item/reasoning/textDelta' || method === 'item/reasoning/summaryTextDelta') {
    return typeof p.delta === 'string' ? { type: 'status', text: p.delta.slice(0, 160) } : null
  }
  // tool-call lifecycle → the same structured ToolCall chips as the exec path, so
  // the agent's work (MCP review tools, shell, edits) is visible in the chat.
  if (method === 'item/started' || method === 'item/completed') {
    return appServerItemToEvent(p.item, method === 'item/completed')
  }
  return null
}

/** Codex tool arguments → kv pairs for the expanded tool-call row. */
function kvOf(args: unknown): [string, string][] {
  if (!args || typeof args !== 'object') return []
  return Object.entries(args as Record<string, unknown>)
    .filter(([, v]) => typeof v === 'string' || typeof v === 'number')
    .map(([k, v]) => [k, String(v)] as [string, string])
}

function resultText(result: unknown): string {
  const content = (result as { content?: unknown })?.content
  if (!Array.isArray(content)) return ''
  return content.map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : '')).join('')
}

/** Map a v2 ThreadItem (mcpToolCall | commandExecution | fileChange) to a ToolCall
 *  event. `done` = item/completed (else item/started). Other item types → null. */
export function appServerItemToEvent(rawItem: unknown, done: boolean): EngineEvent | null {
  const item = (rawItem && typeof rawItem === 'object' ? rawItem : {}) as Record<string, unknown>
  if (item.type === 'mcpToolCall') {
    const tool = String(item.tool ?? '')
    const base = { id: String(item.id ?? ''), verb: deriveVerb(tool), name: tool }
    if (!done) return { type: 'tool', call: { ...base, kv: kvOf(item.arguments), state: 'run' } }
    if (item.error != null || item.status === 'failed') {
      const msg = (item.error as { message?: string } | null)?.message
      return { type: 'tool', call: { ...base, state: 'err', out: msg ?? `${tool} failed` } }
    }
    const { out, outMore } = clampOut(resultText(item.result))
    return { type: 'tool', call: { ...base, state: 'ok', ...(out ? { out } : {}), ...(outMore ? { outMore } : {}) } }
  }
  if (item.type === 'commandExecution') {
    const arg = String(item.command ?? '').slice(0, 120)
    const base = { id: String(item.id ?? ''), verb: 'bash' as const, name: 'command_execution', arg }
    if (!done) return { type: 'tool', call: { ...base, state: 'run' } }
    const failed = item.status === 'failed' || (typeof item.exitCode === 'number' && item.exitCode !== 0)
    const { out, outMore } = clampOut(String(item.aggregatedOutput ?? ''))
    return { type: 'tool', call: { ...base, state: failed ? 'err' : 'ok', ...(out ? { out } : {}), ...(outMore ? { outMore } : {}) } }
  }
  if (item.type === 'fileChange' && done) {
    const changes = Array.isArray(item.changes) ? (item.changes as Array<{ path?: string }>) : []
    const paths = changes.map((c) => String(c.path ?? ''))
    return { type: 'tool', call: { id: String(item.id ?? ''), verb: 'edit', name: 'file_change', arg: paths.join(', ').slice(0, 120), meta: `${paths.length} file${paths.length === 1 ? '' : 's'}`, state: item.status === 'failed' ? 'err' : 'ok' } }
  }
  return null
}

// ── stateful client ───────────────────────────────────────────

function expandHome(p: string | undefined): string | undefined {
  if (!p) return undefined
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p
}

interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void }

/** One long-lived app-server child. Reused across a thread's turns. */
export class AppServerConn {
  private child: ChildProcessWithoutNullStreams
  private nextId = 1
  private pending = new Map<number, Pending>()
  private stdoutBuf = ''
  private onNotify: ((method: string, params: unknown) => void) | null = null
  private onServerRequest: ((id: number | string, method: string, params: unknown) => void) | null = null
  threadId: string | null = null

  constructor(mcpConfigArgs: string[] = []) {
    const bin = codexBinaryPath() ?? 'codex'
    this.child = spawn(bin, ['app-server', ...mcpConfigArgs], {
      env: { ...process.env, ...(expandHome(process.env.CODEX_HOME) ? { CODEX_HOME: expandHome(process.env.CODEX_HOME) } : {}) }
    }) as ChildProcessWithoutNullStreams
    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => this.ingest(chunk))
    this.child.on('exit', () => { for (const p of this.pending.values()) p.reject(new Error('app-server exited')); this.pending.clear() })
  }

  private ingest(chunk: string): void {
    const { messages, rest } = decodeChunk(this.stdoutBuf + chunk)
    this.stdoutBuf = rest
    for (const msg of messages) this.route(msg)
  }

  private route(msg: unknown): void {
    const m = msg as Record<string, unknown>
    switch (classifyMessage(msg)) {
      case 'response': {
        const p = this.pending.get(Number(m.id))
        if (!p) return
        this.pending.delete(Number(m.id))
        if (m.error) p.reject(new Error(String((m.error as { message?: string }).message ?? 'app-server error')))
        else p.resolve(m.result)
        break
      }
      case 'notification':
        this.onNotify?.(String(m.method), m.params)
        break
      case 'request':
        this.onServerRequest?.(m.id as number | string, String(m.method), m.params)
        break
      default:
        break
    }
  }

  request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++
    this.child.stdin.write(encodeFrame({ jsonrpc: '2.0', id, method, params }))
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
  }

  notify(method: string, params?: unknown): void {
    this.child.stdin.write(encodeFrame({ jsonrpc: '2.0', method, params }))
  }

  respond(id: number | string, result: unknown): void {
    this.child.stdin.write(encodeFrame({ jsonrpc: '2.0', id, result }))
  }

  respondError(id: number | string, code: number, message: string): void {
    this.child.stdin.write(encodeFrame({ jsonrpc: '2.0', id, error: { code, message } }))
  }

  setHandlers(onNotify: (m: string, p: unknown) => void, onServerRequest: (id: number | string, m: string, p: unknown) => void): void {
    this.onNotify = onNotify
    this.onServerRequest = onServerRequest
  }

  /** initialize → initialized → thread/start|resume. */
  async handshake(resumeThreadId?: string): Promise<void> {
    await this.request('initialize', { clientInfo: { name: 'limn', version: '0' }, capabilities: { experimentalApi: true } })
    this.notify('initialized')
    const res = resumeThreadId
      ? await this.request('thread/resume', { threadId: resumeThreadId })
      : await this.request('thread/start', {})
    // thread/start returns { thread: { id, sessionId, … } } (verified, 0.135.0).
    const r = res as { thread?: { id?: string }; threadId?: string }
    this.threadId = String(r.thread?.id ?? r.threadId ?? resumeThreadId ?? '')
  }

  dispose(): void {
    try { this.child.kill() } catch { /* already gone */ }
  }
}

function modelEffort(model?: string, effort?: ReasoningEffort): Record<string, unknown> {
  return { ...(model ? { model } : {}), ...(effort && effort !== 'max' ? { effort } : {}) }
}

/** Run one chat turn over the app-server with interactive approvals. */
export function chatViaAppServer(turn: ChatTurn): EngineRun<string> {
  const q = new EventQueue()
  const write = Boolean(turn.writeEnabled)
  const mode = turn.executionMode ?? DEFAULT_EXECUTION_MODE
  const prompt = write
    ? turn.message
    : turn.engineSessionId
      ? buildChatPrompt(turn.message, turn.anchor)
      : buildSeededChatPrompt(turn.context ?? { base: '', branch: '' }, turn.message, turn.anchor)

  let conn: AppServerConn | null = null
  const result = (async (): Promise<{ value: string; sessionId: string }> => {
    let release: (() => Promise<void>) | null = null
    let finalText = ''
    try {
      let mcpArgs: string[] = []
      if (turn.tools) {
        const mcp = await registerCodexTurn(turn.tools)
        release = mcp.release
        mcpArgs = ['-c', `mcp_servers.limn.url=${mcp.url}`]
      }
      conn = new AppServerConn(mcpArgs)
      let resolveTurn: (() => void) | null = null
      let turnErr: string | null = null
      const turnDone = new Promise<void>((res) => { resolveTurn = res })

      conn.setHandlers(
        (method, params) => {
          if (/turn\/completed|turn\/aborted/.test(method)) { resolveTurn?.(); return }
          if (/^error$/.test(method)) { turnErr = String((params as { message?: string })?.message ?? 'error'); resolveTurn?.(); return }
          const ev = appServerNotifToEvent(method, params)
          if (ev) { if (ev.type === 'text') finalText += ev.text; q.push(ev) }
        },
        (id, method, params) => {
          // MCP tool-call approvals arrive as an RMCP elicitation (verified against
          // codex 0.135 app-server: method `mcpServer/elicitation/request`, _meta
          // .codex_approval_kind='mcp_tool_call'). Our limn tools only mutate
          // review metadata, so auto-ACCEPT them (response shape is {action,content,
          // _meta}, NOT {decision}). Without this the turn's tool calls are cancelled
          // ("user cancelled MCP tool call"). Non-tool-call elicitations: decline.
          if (method === 'mcpServer/elicitation/request') {
            const kind = (params as { _meta?: { codex_approval_kind?: string } } | null)?._meta?.codex_approval_kind
            conn?.respond(id, { action: kind === 'mcp_tool_call' ? 'accept' : 'decline', content: null, _meta: null })
            return
          }
          if (isApprovalMethod(method) && turn.opId) {
            const req = approvalRequestFromParams(String(id), params)
            void awaitDecision(turn.opId, req, (e) => q.push(e))
              .then((d) => conn?.respond(id, { decision: mapApprovalDecision(d) }))
          } else {
            conn?.respondError(id, -32601, 'methodNotFound') // unsupported surface → back off
          }
        }
      )

      await conn.handshake(turn.engineSessionId)
      await conn.request('turn/start', {
        threadId: conn.threadId,
        input: [{ type: 'text', text: prompt, text_elements: [] }],
        cwd: turn.repo,
        approvalPolicy: approvalPolicyFor(mode),
        // route approvals to US (the reviewer), not the guardian subagent that
        // auto-denies untrusted MCP/exec in headless mode — the core unblock.
        approvalsReviewer: 'user',
        sandboxPolicy: sandboxPolicyFor(mode, turn.repo, write),
        ...modelEffort(turn.model, turn.reasoningEffort)
      })
      await turnDone
      if (turnErr) throw new Error(`Codex run failed: ${turnErr}`)
      q.push({ type: 'done' })
      return { value: finalText, sessionId: conn.threadId || turn.engineSessionId || '' }
    } catch (err) {
      q.push({ type: 'error', message: err instanceof Error ? err.message : String(err) })
      throw err
    } finally {
      q.close()
      conn?.dispose()
      if (release) await release()
    }
  })()

  return { events: q.iterable(), result, cancel: () => { conn?.dispose() } }
}
