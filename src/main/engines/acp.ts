import { Readable, Writable } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type McpServer,
  type PermissionOption,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification
} from '@agentclientprotocol/sdk'
import { ZodError } from 'zod'
import type { ReasoningEffort, ReviewAnnotations, ExecutionMode } from '../../shared/types.js'
import { ladderPolicy } from '../../shared/approvalPolicy.js'
import { acpToEvents, acpPermissionToRequest } from './acpEvents.js'
import { awaitDecision, clearPending } from './approvals.js'
import { registerTurn } from './mcpHost.js'
import { buildReviewPrompt, buildScopedUpdatePrompt, buildChatPrompt, buildSeededChatPrompt } from './prompts.js'
import { parseJson, structuredEpilogue, buildRepairPrompt } from './structured.js'
import {
  reviewJsonSchema,
  scopedReviewJsonSchema,
  parseReviewOutput,
  parseScopedOutput,
  type ScopedReviewPatch
} from './schema.js'
import { EventQueue, type ChatTurn, type EngineRun, type ReviewEngine, type ReviewRequest, type ScopedUpdateRequest } from './types.js'
import type { AgentToolHost } from './tools.js'
import type { AcpEngineConfig } from './adapters.js'
import { spawnAdapter } from './adapters.js'

/** A thrown error whose message contains "cancelled" so `ipc.ts`'s
 *  `isCancellation` classifies it as a user cancel (no error strip). */
const CANCELLED = 'cancelled'

/** Compact one-line-per-issue ZodError formatting for the repair prompt. */
function formatZodIssues(err: ZodError): string {
  return err.issues.map((i) => `- ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n')
}

/** Tag a final structured-parse failure so `runAcpTurn`'s outer catch re-throws it
 *  UNWRAPPED (preserving `ZodError.name` for ipc.ts's friendly-copy gate) instead of
 *  wrapping it and pushing a raw `{type:'error'}` event. The mark rides on the error
 *  object itself, so the ZodError identity is untouched. */
const STRUCTURED_PARSE = Symbol('structuredParse')
function markStructuredParse(err: unknown): unknown {
  if (err && typeof err === 'object') (err as Record<symbol, unknown>)[STRUCTURED_PARSE] = true
  return err
}
function isStructuredParse(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as Record<symbol, unknown>)[STRUCTURED_PARSE])
}

/** Pick the option whose kind matches (allow → allow_once, deny → reject_once);
 *  falls back to the first option so a non-standard adapter still gets an answer. */
function optionFor(options: PermissionOption[], decision: 'allow' | 'deny'): string | undefined {
  const wanted = decision === 'allow' ? 'allow_once' : 'reject_once'
  const match = options.find((o) => o.kind === wanted)
  return (match ?? options[0])?.optionId
}

interface AcpTurnOptions<T> {
  repo: string
  prompt: string
  /** resume this engine session when set. */
  engineSessionId?: string
  model?: string
  reasoningEffort?: ReasoningEffort
  tools?: AgentToolHost
  writeEnabled?: boolean
  opId?: string
  executionMode?: ExecutionMode
  /** suppress streamed text events (structured generate turns). */
  structured?: boolean
  /** identity for chat; parse∘extract for review/scoped — throws → one repair turn. */
  parse: (text: string) => T
  status?: string
}

export class AcpEngine implements ReviewEngine {
  readonly id: AcpEngineConfig['id']

  constructor(private readonly config: AcpEngineConfig) {
    this.id = config.id
  }

  generateReview(req: ReviewRequest): EngineRun<ReviewAnnotations> {
    return this.runAcpTurn<ReviewAnnotations>({
      repo: req.repo,
      prompt: buildReviewPrompt(req) + '\n' + structuredEpilogue(reviewJsonSchema),
      model: req.model,
      reasoningEffort: req.reasoningEffort,
      writeEnabled: true,
      executionMode: 'edits',
      structured: true,
      status: 'Starting review…',
      parse: (t) => parseReviewOutput(parseJson(t))
    })
  }

  generateScopedUpdate(req: ScopedUpdateRequest): EngineRun<ScopedReviewPatch> {
    return this.runAcpTurn<ScopedReviewPatch>({
      repo: req.repo,
      prompt:
        buildScopedUpdatePrompt({ branch: req.branch, base: req.base, prior: req.prior, since: req.since, sinceSha: req.sinceSha, steer: req.steer }) +
        '\n' +
        structuredEpilogue(scopedReviewJsonSchema),
      engineSessionId: req.priorEngineSessionId,
      model: req.model,
      reasoningEffort: req.reasoningEffort,
      writeEnabled: true,
      executionMode: 'edits',
      structured: true,
      status: 'Updating review…',
      parse: (t) => parseScopedOutput(parseJson(t))
    })
  }

  chat(turn: ChatTurn): EngineRun<string> {
    const write = Boolean(turn.writeEnabled)
    const prompt = write
      ? turn.message
      : turn.engineSessionId
        ? buildChatPrompt(turn.message, turn.anchor)
        : buildSeededChatPrompt(turn.context ?? { base: '', branch: '' }, turn.message, turn.anchor)
    return this.runAcpTurn<string>({
      repo: turn.repo,
      prompt,
      engineSessionId: turn.engineSessionId,
      model: turn.model,
      reasoningEffort: turn.reasoningEffort,
      tools: turn.tools,
      writeEnabled: turn.writeEnabled,
      opId: turn.opId,
      executionMode: turn.executionMode,
      structured: false,
      parse: (t) => t
    })
  }

  /** The one generic turn lifecycle every method delegates to (spec §D1): spawn
   *  the adapter, run initialize → session → set_mode → prompt, stream updates to
   *  events, route permissions through the ladder, and validate + one repair turn
   *  inside the live session. Mirrors `runAppServerTurn`'s settle/finally discipline. */
  private runAcpTurn<T>(opts: AcpTurnOptions<T>): EngineRun<T> {
    const q = new EventQueue()
    if (opts.status) q.push({ type: 'status', text: opts.status })
    const mode: ExecutionMode = opts.executionMode ?? 'ask'
    const write = Boolean(opts.writeEnabled)

    let child: ChildProcessWithoutNullStreams | null = null
    let conn: ClientSideConnection | null = null
    let aborted = false
    let sessionId = ''
    let stderrTail = ''

    // Resolves when cancel() fires — races the permission wait so a pending
    // request gets the ACP-required `cancelled` outcome, not a reviewer answer.
    let onCancel: () => void = () => {}
    const cancelled = new Promise<void>((res) => { onCancel = res })

    const result = (async (): Promise<{ value: T; sessionId: string }> => {
      let release: (() => Promise<void>) | null = null
      // Reset per prompt; accumulates agent_message_chunk text (even when suppressed).
      let finalText = ''
      let replaying = true

      try {
        // (a) MCP host for tool-enabled turns.
        let mcpServers: McpServer[] = []
        if (opts.tools) {
          const mcp = await registerTurn(opts.tools)
          release = mcp.release
          mcpServers = [{ type: 'http', name: 'limn', url: mcp.url, headers: [] }]
        }

        // (b) spawn the adapter and wire an ACP ClientSideConnection over its stdio.
        child = spawnAdapter(this.config.adapterEntry, this.config.env?.({ model: opts.model, reasoningEffort: opts.reasoningEffort }) ?? {})
        child.stderr.setEncoding('utf8')
        child.stderr.on('data', (d: string) => { stderrTail = (stderrTail + d).slice(-4000) })
        child.on('error', (e: Error) => { stderrTail = (stderrTail + `spawn error: ${String(e)}`).slice(-4000) })

        const toAgent = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>
        const fromAgent = Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>

        // (c) the Client handler: stream updates → events (with replay suppression),
        //     route permissions through the ladder.
        const client: Client = {
          sessionUpdate: (params: SessionNotification): void => {
            // Drop everything until session/new|load resolves — replay is history
            // Limn already holds in its own DB (spec §D1 step 4).
            if (replaying) return
            for (const ev of acpToEvents(params.update)) {
              if (ev.type === 'text') {
                finalText += ev.text
                if (opts.structured) continue // suppress streamed text on generate turns
              }
              q.push(ev)
            }
          },
          requestPermission: async (params: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
            const req = acpPermissionToRequest(params, this.config.id)
            const decision = ladderPolicy(mode, req, write)
            const options = params.options ?? []
            if (decision === 'allow' || decision === 'deny') {
              const optionId = optionFor(options, decision)
              return optionId ? { outcome: { outcome: 'selected', optionId } } : { outcome: { outcome: 'cancelled' } }
            }
            // 'ask' — park on the reviewer's decision, but answer `cancelled` if the
            // turn is cancelled while parked (ACP requires it for pending requests).
            const decided = opts.opId
              ? awaitDecision(opts.opId, req, (e) => q.push(e)).then((d): 'allow' | 'deny' | 'cancel' => d)
              : Promise.resolve<'allow' | 'deny' | 'cancel'>('deny')
            const outcome = await Promise.race([decided, cancelled.then((): 'cancel' => 'cancel')])
            if (outcome === 'cancel') return { outcome: { outcome: 'cancelled' } }
            const optionId = optionFor(options, outcome)
            return optionId ? { outcome: { outcome: 'selected', optionId } } : { outcome: { outcome: 'cancelled' } }
          },
          readTextFile: () => { throw new Error('fs.readTextFile declined') },
          writeTextFile: () => { throw new Error('fs.writeTextFile declined') }
        }

        conn = new ClientSideConnection(() => client, ndJsonStream(toAgent, fromAgent))

        // (d) initialize + protocol-version guard (OQ10).
        const init = await conn.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }
        })
        if (init.protocolVersion !== PROTOCOL_VERSION) {
          throw new Error(`ACP adapter negotiated protocol v${init.protocolVersion}, but Limn speaks v${PROTOCOL_VERSION}. Update Limn to use this adapter.`)
        }
        const canLoad = init.agentCapabilities?.loadSession === true
        const canResume = Boolean((init.agentCapabilities?.sessionCapabilities as { resume?: unknown } | undefined)?.resume)

        // (e) session: `newSession` ONLY when there is no id to resume. When an id is
        // set, a `resume`/`load` failure REJECTS the turn (before any text/tool event) —
        // ipc.ts's `isLostEngineSession` → `ENGINE_SESSION_LOST` "start a new chat"
        // affordance handles it exactly as for the old engines (spec §D6). We never
        // silently mint an UNseeded fresh session for a failed resume: chat() already
        // built a non-seeded prompt (engineSessionId was truthy) and ipc passes no
        // context, so a fresh session would answer with no review/diff context.
        if (opts.engineSessionId) {
          if (canResume) await conn.resumeSession({ sessionId: opts.engineSessionId, cwd: opts.repo, mcpServers })
          else if (canLoad) await conn.loadSession({ sessionId: opts.engineSessionId, cwd: opts.repo, mcpServers })
          else throw new Error(`ACP adapter cannot resume session ${opts.engineSessionId} (no loadSession capability)`)
          sessionId = opts.engineSessionId
        } else {
          const fresh = await conn.newSession({ cwd: opts.repo, mcpServers })
          sessionId = fresh.sessionId
        }
        replaying = false // post-setup updates are live turn output, not replay

        // (f) set mode + config options (best-effort; swallow method-not-found / no-ops).
        try {
          await conn.setSessionMode({ sessionId, modeId: this.config.modeFor(mode, write) })
        } catch { /* forward-compat: modes are slated for removal */ }
        for (const opt of this.config.configOptions?.({ model: opts.model, reasoningEffort: opts.reasoningEffort }) ?? []) {
          try {
            await conn.setSessionConfigOption({ sessionId, configId: opt.configId, value: opt.value })
          } catch { /* config-option passthrough is advisory — unknown ids are swallowed */ }
        }

        // (g) prompt + validate + one repair (spec §D5), on the SAME live session.
        const promptOnce = async (text: string): Promise<string> => {
          finalText = ''
          const res = await conn!.prompt({ sessionId, prompt: [{ type: 'text', text }] })
          if (res.stopReason === 'end_turn') return finalText
          if (res.stopReason === 'cancelled') throw new Error(CANCELLED)
          throw new Error(`ACP turn stopped: ${res.stopReason}`) // refusal / max_tokens / max_turn_requests
        }

        let value: T
        const first = await promptOnce(opts.prompt)
        try {
          value = opts.parse(first)
        } catch (firstErr) {
          // one automatic repair turn on the SAME live session (D5).
          const issues = firstErr instanceof ZodError ? formatZodIssues(firstErr) : String(firstErr)
          const repaired = await promptOnce(buildRepairPrompt(issues))
          try {
            value = opts.parse(repaired)
          } catch (finalErr) {
            // Final structured-parse failure: propagate UNWRAPPED (preserve
            // ZodError.name so ipc.ts's friendly-copy gate fires) and push NO raw
            // {type:'error'} event — exactly as CodexEngine, which parses in a `.then`
            // outside the turn. The outer catch recognizes the mark and re-throws it.
            throw markStructuredParse(finalErr)
          }
        }

        // (h) done.
        q.push({ type: 'done' })
        return { value, sessionId }
      } catch (err) {
        // A cancel kills the child mid-turn, so the prompt/init promise rejects with
        // an opaque transport error — reclassify it as the quiet cancelled sentinel.
        if (aborted || (err instanceof Error && err.message === CANCELLED)) {
          throw new Error(CANCELLED, { cause: err }) // quiet settle — no error strip
        }
        // A structured-parse failure (D5): surface it as the raw parse error so
        // ipc.ts renders its friendly copy — do NOT wrap (loses ZodError.name) and do
        // NOT push a raw {type:'error'} event (matches CodexEngine).
        if (isStructuredParse(err)) throw err
        const tail = stderrTail.trim()
        const message = (err instanceof Error ? err.message : String(err)) + (tail ? `\n${tail.split('\n').slice(-4).join('\n')}` : '')
        q.push({ type: 'error', message })
        throw new Error(message, { cause: err })
      } finally {
        q.close()
        killTree(child)
        if (release) await release()
      }
    })()

    const cancel = (): void => {
      aborted = true
      onCancel() // answer any parked permission with `cancelled`
      if (opts.opId) clearPending(opts.opId)
      if (sessionId && conn) void conn.cancel({ sessionId }).catch(() => {})
      killTree(child)
    }

    return { events: q.iterable(), result, cancel }
  }
}

/** Kill the child's whole process group (negative pid) so adapter-spawned tool/
 *  shell descendants die too; fall back to a direct kill. */
function killTree(child: ChildProcessWithoutNullStreams | null): void {
  if (!child) return
  const pid = child.pid
  try {
    if (pid) process.kill(-pid, 'SIGTERM')
    else child.kill()
  } catch {
    try { child.kill() } catch { /* already gone */ }
  }
}
