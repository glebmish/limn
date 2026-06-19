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

/**
 * Hand-written `codex app-server` JSON-RPC-over-stdio client (the bidirectional
 * protocol that *can* answer approval server-requests — unlike `codex exec`).
 *
 * ⚠️ LIVE-UNVERIFIED: built against the spec + the reference implementation reference
 * (`a reference implementation`), but not exercised against a real `codex app-server`
 * here (no Codex CLI/auth/network). It is gated behind `LR_CODEX_APP_SERVER=1`;
 * the `codex exec` path in `codex.ts` stays the default fallback. The exact
 * method/param names should be pinned via `codex app-server generate-ts` against
 * the installed binary before flipping the default. The PURE helpers below
 * (framing, routing, decision/policy mapping, notification→event) are unit-tested.
 */

export function appServerEnabled(): boolean {
  return process.env.LR_CODEX_APP_SERVER === '1'
}

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
 *  app-server generate-ts`, 0.135.0): legacy `execCommandApproval`/`applyPatchApproval`
 *  + the v2 `item/.../requestApproval` pair. Everything else (requestUserInput,
 *  elicitation, item/permissions/requestApproval, item/tool/call) is an unsupported
 *  surface we auto-deny so the turn never wedges. */
const APPROVAL_METHODS = new Set([
  'execCommandApproval',
  'applyPatchApproval',
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
])
export function isApprovalMethod(method: string): boolean {
  return APPROVAL_METHODS.has(method)
}

/** Map our decision to the app-server's approval result value. Some binaries use
 *  `approved|denied` (legacy), others `accept|decline` (modern) — pin against the
 *  installed binary. We emit the legacy form and accept either on the wire. */
export function mapApprovalDecision(decision: ApprovalDecision): 'approved' | 'denied' {
  return decision === 'allow' ? 'approved' : 'denied'
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

/** Build an ApprovalRequest from an app-server approval server-request's params.
 *  Handles the legacy shapes (`command: string[]` + `cwd`; `fileChanges: {[path]}`)
 *  and the v2 shapes (`command: string` + `cwd`; fileChange carries only `itemId`/
 *  `reason`). Read leniently — params differ across the 4 approval methods. */
export function approvalRequestFromParams(id: string, params: unknown): ApprovalRequest {
  const p = (params && typeof params === 'object' ? params : {}) as Record<string, unknown>
  const command = typeof p.command === 'string' ? p.command
    : Array.isArray(p.command) ? (p.command as unknown[]).join(' ') : undefined
  const cwd = typeof p.cwd === 'string' ? p.cwd : undefined
  const files = p.fileChanges && typeof p.fileChanges === 'object'
    ? Object.keys(p.fileChanges as Record<string, unknown>)
    : Array.isArray(p.files) ? (p.files as unknown[]).map(String) : undefined
  const reason = typeof p.reason === 'string' ? p.reason : undefined
  if (command) return { id, engine: 'codex', kind: 'command', summary: `Run \`${command}\``, detail: { command, ...(cwd ? { cwd } : {}), ...(reason ? { reason } : {}) } }
  if (files && files.length) return { id, engine: 'codex', kind: 'patch', summary: `Apply changes to ${files.length} file(s)`, detail: { files, ...(reason ? { reason } : {}) } }
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
  return null
}

// ── stateful client (live-unverified) ─────────────────────────

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
    await this.request('initialize', { clientInfo: { name: 'local-review', version: '0' }, capabilities: { experimentalApi: true } })
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

/** Run one chat turn over the app-server (the `LR_CODEX_APP_SERVER` path). Mirrors
 *  `codex.ts` `chat()` but with interactive approvals. ⚠️ live-unverified. */
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
        mcpArgs = ['-c', `mcp_servers.localreview.url=${mcp.url}`]
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
