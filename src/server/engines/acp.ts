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
  type SessionModeState,
  type SessionNotification
} from '@agentclientprotocol/sdk'
import { ZodError } from 'zod'
import type { ReasoningEffort, ExecutionMode, ApprovalDiff } from '../../shared/types.js'
import { generationLadder, ladderPolicy, readOnlyLadder } from '../../shared/approvalPolicy.js'
import { acpToEvents, acpPermissionToRequest, diffBlocks, toApprovalDiffs } from './acpEvents.js'
import { CancelledError, EngineSessionLostError } from './errors.js'
import { awaitDecision, clearPending } from './approvals.js'
import { registerTurn } from './mcpHost.js'
import { engineBinaryStatus } from './binaries.js'
import { buildReviewPrompt, buildScopedUpdatePrompt, buildChatPrompt, buildSeededChatPrompt } from './prompts.js'
import { parseJson, structuredEpilogue, buildRepairPrompt } from './structured.js'
import {
  reviewJsonSchema,
  scopedReviewJsonSchema,
  parseReviewOutput,
  type ParsedReview,
  parseScopedOutput,
  type ScopedReviewPatch
} from './schema.js'
import { EventQueue, type ChatTurn, type EngineRun, type ReviewEngine, type ReviewRequest, type ScopedUpdateRequest } from './types.js'
import type { AgentToolHost } from './tools.js'
import type { AcpEngineConfig } from './adapters.js'
import { spawnAdapter } from './adapters.js'

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

/** Pick the option whose kind matches the decision's FAMILY — allow → allow_once
 *  then allow_always, deny → reject_once then reject_always. Never positional: an
 *  adapter lists its allow options first, so falling back to `options[0]` would
 *  answer a deny with an allow whenever the adapter spelled rejection some other
 *  way. `undefined` means "this adapter offers nothing in that family"; the caller
 *  answers `cancelled`, which every adapter treats as not-permitted. */
function optionFor(options: PermissionOption[], decision: 'allow' | 'deny'): string | undefined {
  const wanted = decision === 'allow' ? (['allow_once', 'allow_always'] as const) : (['reject_once', 'reject_always'] as const)
  for (const kind of wanted) {
    const match = options.find((o) => o.kind === kind)
    if (match) return match.optionId
  }
  return undefined
}

/** Session/new|load|resume responses carry the session's advertised mode ids on
 *  `modes.availableModes` (spec §D3 addendum) — reduce to bare ids for `modeFor`. */
function modeIdsFrom(modes: SessionModeState | null | undefined): string[] | undefined {
  return modes?.availableModes.map((m) => m.id)
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
  /** re-read the tier at each permission request (mid-turn mode changes). */
  currentMode?: () => ExecutionMode
  /** force read-only mode + deny-all-non-limn permissions regardless of tier. */
  readOnly?: boolean
  /** structured generation turn (review / scoped update): suppress streamed text
   *  AND route permissions through `generationLadder` — its own explicit policy
   *  (commands allowed, file changes denied), not a chat tier. The session mode is
   *  the non-write one (`modeFor(mode, false)`) so file edits surface as permission
   *  requests for the ladder to deny instead of being engine-auto-accepted. */
  generation?: boolean
  /** identity for chat; parse∘extract for review/scoped — throws → one repair turn. */
  parse: (text: string) => T
  status?: string
}

export class AcpEngine implements ReviewEngine {
  readonly id: AcpEngineConfig['id']

  constructor(private readonly config: AcpEngineConfig) {
    this.id = config.id
  }

  generateReview(req: ReviewRequest): EngineRun<ParsedReview> {
    return this.runAcpTurn<ParsedReview>({
      repo: req.repo,
      prompt: buildReviewPrompt(req) + '\n' + structuredEpilogue(reviewJsonSchema),
      model: req.model,
      reasoningEffort: req.reasoningEffort,
      generation: true,
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
      generation: true,
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
      currentMode: turn.currentMode,
      readOnly: turn.readOnly,
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
    // A read-only shared-lane turn is never write-capable, whatever the tier says.
    // Generation turns pass no writeEnabled either: their session mode must be the
    // non-write one so file edits ASK (and generationLadder denies them) rather
    // than being auto-accepted engine-side.
    const readOnly = Boolean(opts.readOnly)
    const generation = Boolean(opts.generation)
    const write = Boolean(opts.writeEnabled) && !readOnly

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
        // Fail fast with an actionable error in the two cases the adapter cannot
        // recover from: (1) the adapter can't self-discover its native binary and
        // Limn can't resolve one either (Codex: the bundled fallback is stripped from
        // the package, so a missing `codex` would otherwise crash the adapter with a
        // raw MODULE_NOT_FOUND); (2) the user CONFIGURED a path in Settings and it is
        // broken — `binaryEnv` hands a configured path to the adapter unvalidated, so
        // without this the turn would die with whatever raw spawn error the adapter
        // produced instead of the hint Settings already shows. An UNconfigured,
        // unresolved binary is left alone: Claude's adapter discovers `claude` itself.
        const st = engineBinaryStatus(this.config.id)
        if ((this.config.binaryRequired || st.configured) && !st.ok) throw new Error(st.hint)
        child = spawnAdapter(this.config.adapterEntry, {
          ...this.config.env?.({ model: opts.model, reasoningEffort: opts.reasoningEffort }),
          ...this.config.binaryEnv?.()
        })
        child.stderr.setEncoding('utf8')
        child.stderr.on('data', (d: string) => { stderrTail = (stderrTail + d).slice(-4000) })
        child.on('error', (e: Error) => { stderrTail = (stderrTail + `spawn error: ${String(e)}`).slice(-4000) })

        const toAgent = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>
        const fromAgent = Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>

        // (c) the Client handler: stream updates → events (with replay suppression),
        //     route permissions through the ladder.
        // toolCallId → title of every tool_call seen this turn, so an MCP-tool
        // approval that arrives with no title (codex-acp's correlated elicitation
        // shape) can recover the tool name for the limn auto-allow.
        const toolTitles = new Map<string, string>()
        // toolCallId → diff blocks of the last tool_call(_update) that carried
        // one, so a file-change permission request whose own toolCall omits
        // content (codex-acp's bare `{ toolCallId, kind: 'edit' }` approvals —
        // see acpPermissionToRequest's doc comment) can still show a path/diff
        // preview from the item/started update that preceded it.
        const toolDiffs = new Map<string, ApprovalDiff[]>()
        const client: Client = {
          sessionUpdate: (params: SessionNotification): void => {
            const u = params.update
            if (u.sessionUpdate === 'tool_call' && u.title) toolTitles.set(u.toolCallId, u.title)
            if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') {
              const diffs = diffBlocks(u.content)
              if (diffs.length) toolDiffs.set(u.toolCallId, toApprovalDiffs(diffs))
            }
            // Drop everything until session/new|load resolves — replay is history
            // Limn already holds in its own DB (spec §D1 step 4).
            if (replaying) return
            for (const ev of acpToEvents(u)) {
              if (ev.type === 'text') {
                finalText += ev.text
                if (generation) continue // suppress streamed text on generate turns
              }
              q.push(ev)
            }
          },
          requestPermission: async (params: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
            const req = acpPermissionToRequest(params, this.config.id, toolTitles, toolDiffs)
            // The tier is read PER REQUEST, not captured at turn start, so the mode
            // selector keeps working while a turn streams. What a mid-turn change can
            // reach is bounded by the session mode negotiated once at (f) below — it is
            // never re-negotiated. `ask`/`edits`/`auto` are identical at the ladder
            // (ladderPolicy always answers 'ask' for a surfaced request below `full`),
            // so switching among them mid-turn changes nothing until the next turn
            // renegotiates the session mode. The only mid-turn transition with live
            // effect is `full` ↔ a lower tier: dropping out of `full` makes the ladder
            // start parking subsequent requests again; rising into `full` makes it
            // start auto-allowing them (whatever the session mode auto-accepts
            // engine-side never reaches us to be re-tiered either way).
            const tier = opts.currentMode?.() ?? mode
            const policy = generation ? generationLadder(req) : readOnly ? readOnlyLadder(req) : ladderPolicy(tier, req, write)
            // 'ask' parks on the reviewer's decision, racing cancel so a pending
            // request gets the ACP-required `cancelled` outcome. A turn with no opId
            // has no approval surface to park on, so its 'ask' degrades to deny.
            const decision: 'allow' | 'deny' | 'cancel' =
              policy !== 'ask'
                ? policy
                : await Promise.race([
                    opts.opId ? awaitDecision(opts.opId, req, (e) => q.push(e)) : Promise.resolve<'allow' | 'deny'>('deny'),
                    cancelled.then((): 'cancel' => 'cancel')
                  ])
            if (decision === 'cancel') return { outcome: { outcome: 'cancelled' } }
            const optionId = optionFor(params.options ?? [], decision)
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
        // set, a `resume`/`load` REJECTION is the one place a session is GENUINELY
        // lost — it throws the typed `EngineSessionLostError` so ipc.ts's
        // `ENGINE_SESSION_LOST` "start a new chat" affordance fires (spec §D6). A
        // missing `loadSession` capability is a systemic adapter problem, not a lost
        // session — it keeps a generic error. We never silently mint an UNseeded
        // fresh session for a failed resume: chat() already built a non-seeded prompt
        // (engineSessionId was truthy) and ipc passes no context, so a fresh session
        // would answer with no review/diff context.
        // The session's advertised mode ids (when the adapter returns them) so
        // `modeFor` can pick the engine's native `auto` only when it is actually on
        // offer, instead of guessing (spec §D3 addendum). `loadSession` may resolve
        // `void` (no modes reported) — `modeIdsFrom(undefined)` is `undefined`, same
        // as "unknown", which keeps `modeFor`'s optimistic-then-fallback behaviour.
        let availableModes: string[] | undefined
        if (opts.engineSessionId) {
          if (!canResume && !canLoad) throw new Error(`ACP adapter cannot resume session ${opts.engineSessionId} (no loadSession capability)`)
          try {
            if (canResume) availableModes = modeIdsFrom((await conn.resumeSession({ sessionId: opts.engineSessionId, cwd: opts.repo, mcpServers }))?.modes)
            else availableModes = modeIdsFrom((await conn.loadSession({ sessionId: opts.engineSessionId, cwd: opts.repo, mcpServers }))?.modes)
          } catch (err) {
            throw new EngineSessionLostError(opts.engineSessionId, err)
          }
          sessionId = opts.engineSessionId
        } else {
          const fresh = await conn.newSession({ cwd: opts.repo, mcpServers })
          sessionId = fresh.sessionId
          availableModes = modeIdsFrom(fresh.modes)
        }
        replaying = false // post-setup updates are live turn output, not replay

        // (f) set mode + config options (best-effort; swallow method-not-found / no-ops).
        // Negotiated ONCE, from the START-TIME tier, and never re-negotiated mid-turn
        // (no respawn, no second set_mode) — see the requestPermission comment for
        // what a mid-turn tier change can and cannot reach.
        //
        // A rejected/unavailable mode id must not silently degrade the tier (no
        // self-rolled classification, no bare-catch either): try the id `modeFor`
        // picks from the session's advertised `availableModes` (or, when those
        // weren't reported, its optimistic guess); on rejection retry ONCE with
        // `modeFor`'s definitively-conservative id (an explicit empty
        // `availableModes` — for claude `auto` that's the spike-measured
        // `acceptEdits` fallback); if that ALSO fails, note it at status level
        // instead of failing the turn (session modes are slated for removal from
        // the protocol, so a permanently-rejecting adapter is forward-compat, not
        // a bug to crash on).
        const primaryModeId = this.config.modeFor(mode, write, availableModes)
        const trySetMode = async (modeId: string): Promise<boolean> => {
          try {
            await conn!.setSessionMode({ sessionId, modeId })
            return true
          } catch {
            return false
          }
        }
        if (!(await trySetMode(primaryModeId))) {
          const fallbackModeId = this.config.modeFor(mode, write, [])
          const recovered = fallbackModeId !== primaryModeId && (await trySetMode(fallbackModeId))
          if (!recovered) {
            q.push({ type: 'status', text: `Couldn't set the "${primaryModeId}" session mode — continuing in the adapter's own default.` })
          }
        }
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
          if (res.stopReason === 'cancelled') throw new CancelledError()
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
            // {type:'error'} event — the parse happens after the turn completes, not
            // as part of it. The outer catch recognizes the mark and re-throws it.
            throw markStructuredParse(finalErr)
          }
        }

        // (h) done.
        q.push({ type: 'done' })
        return { value, sessionId }
      } catch (err) {
        // A cancel kills the child mid-turn, so the prompt/init promise rejects with
        // an opaque transport error — reclassify it as the typed quiet cancel.
        if (aborted || err instanceof CancelledError) {
          throw new CancelledError(err) // quiet settle — no error strip
        }
        // A structured-parse failure (D5): surface it as the raw parse error so
        // ipc.ts renders its friendly copy — do NOT wrap (loses ZodError.name) and do
        // NOT push a raw {type:'error'} event.
        if (isStructuredParse(err)) throw err
        // A lost session must keep its type across this boundary — surface the error
        // event for the live log but re-throw the error itself (no stderr-tail wrap).
        if (err instanceof EngineSessionLostError) {
          q.push({ type: 'error', message: err.message })
          throw err
        }
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
