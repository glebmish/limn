// A scripted ACP *agent* (server side) that speaks real NDJSON ACP over stdio via
// the SDK's `AgentSideConnection`. It is the contract fixture the AcpEngine e2e
// tests run against — no mocks, a real subprocess talking the real protocol.
//
// The test never imports this file's RUNTIME: it points `AcpEngineConfig.adapterEntry`
// at this path and injects a per-spawn script via the `LIMN_FAKE_ACP_SCRIPT` env var.
// Only the `FakeScript` types are shared (via `import type`). The `main()` at the
// bottom is guarded so importing the module for its types never starts an agent.
//
// Runs directly under `node fakeAcpAgent.ts` (Node 24 strips the type annotations) —
// exactly how `spawnAdapter` launches the real adapter's `dist/index.js`.
import { Readable, Writable } from 'node:stream'
import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import {
  AgentSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Agent,
  type InitializeResponse,
  type NewSessionResponse,
  type LoadSessionResponse,
  type PromptResponse,
  type SessionUpdate,
  type StopReason,
  type PermissionOption,
  type ToolCallUpdate
} from '@agentclientprotocol/sdk'

// ── the script the test hands the fake, one per spawn ─────────────────────────

/** A single tool call the fake asks permission for mid-turn. */
export interface FakePermission {
  toolCallId: string
  /** omitted to mimic codex-acp's correlated MCP-approval shape (no title). */
  title?: string
  kind: ToolCallUpdate['kind']
  /** raw command / input surfaced to `acpPermissionToRequest`. */
  rawInput?: unknown
  /** request-level `_meta` (e.g. codex-acp's `{ is_mcp_tool_approval: true }`). */
  meta?: Record<string, unknown>
  /** options offered; defaults to an allow_once / reject_once pair. */
  options?: PermissionOption[]
}

/** One prompt turn's scripted behaviour (index 0 = first prompt, 1 = the repair). */
export interface FakeTurn {
  /** session/update notifications emitted before the (optional) permission + text. */
  updates?: SessionUpdate[]
  /** when set, the fake requests permission and branches on the outcome. */
  permission?: FakePermission
  /** several permission requests raised SEQUENTIALLY in one turn (each awaited
   *  before the next is sent) — how a mid-turn tier change is observed. Takes
   *  precedence over `permission`; the reject branch fires if ANY was rejected. */
  permissions?: FakePermission[]
  /** the agent_message_chunk text emitted as the turn's answer (allow path). */
  text?: string
  /** text emitted when a permission was rejected (reject path). */
  rejectedText?: string
  /** delay (ms) before finishing — a cancellable long turn. */
  delayMs?: number
  /** the stopReason to resolve session/prompt with (default end_turn). */
  stopReason?: StopReason
}

export interface FakeScript {
  /** protocol version echoed at initialize (default = PROTOCOL_VERSION). */
  protocolVersion?: number
  /** advertise session/load support (default true). */
  loadSession?: boolean
  /** advertise session/resume support. */
  resume?: boolean
  /** the sessionId newSession returns (default 'fake-new'). */
  sessionId?: string
  /** make session/load throw → exercises the seeded-fresh fallback. */
  failLoad?: boolean
  /** updates replayed DURING session/load, before it resolves (replay suppression). */
  loadReplayUpdates?: SessionUpdate[]
  /** advertise `modes.availableModes` on the session/new response (T2: proves
   *  `AcpEngine` threads the session's advertised mode ids into `modeFor`). Mapped
   *  to `{ id, name: id }`; `currentModeId` is the first entry (unused by the test). */
  availableModes?: string[]
  /** mode ids on which `session/set_mode` throws (T2: proves the retry-once-with-
   *  fallback path, not just the bare-catch it replaces). */
  rejectSetSessionMode?: string[]
  /** the scripted prompt turns, consumed in order. */
  turns: FakeTurn[]
}

// ── side-channel: record what the fake saw so the test can assert on it ────────

const OUT = process.env.LIMN_FAKE_ACP_OUT
function record(obj: unknown): void {
  if (OUT) {
    try {
      appendFileSync(OUT, JSON.stringify(obj) + '\n')
    } catch {
      /* best effort */
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(t)
      reject(new Error('aborted'))
    })
  })
}

const DEFAULT_OPTIONS: PermissionOption[] = [
  { kind: 'allow_once', name: 'Allow', optionId: 'allow' },
  { kind: 'reject_once', name: 'Reject', optionId: 'reject' }
]

class FakeAgent implements Agent {
  private turnIndex = 0
  private aborters = new Set<AbortController>()
  private readonly conn: AgentSideConnection
  private readonly script: FakeScript

  constructor(conn: AgentSideConnection, script: FakeScript) {
    this.conn = conn
    this.script = script
  }

  initialize(): InitializeResponse {
    return {
      protocolVersion: (this.script.protocolVersion ?? PROTOCOL_VERSION) as InitializeResponse['protocolVersion'],
      agentCapabilities: {
        loadSession: this.script.loadSession ?? true,
        mcpCapabilities: { http: true },
        ...(this.script.resume ? { sessionCapabilities: { resume: {} } } : {})
      },
      authMethods: []
    }
  }

  newSession(params: Parameters<Agent['newSession']>[0]): NewSessionResponse {
    record({ event: 'newSession', cwd: params.cwd, mcpServers: params.mcpServers })
    const ids = this.script.availableModes
    return {
      sessionId: this.script.sessionId ?? 'fake-new',
      ...(ids ? { modes: { currentModeId: ids[0] ?? 'default', availableModes: ids.map((id) => ({ id, name: id })) } } : {})
    }
  }

  async loadSession(params: Parameters<NonNullable<Agent['loadSession']>>[0]): Promise<LoadSessionResponse> {
    record({ event: 'loadSession', sessionId: params.sessionId, mcpServers: params.mcpServers })
    if (this.script.failLoad) throw new Error('fake: cannot load session')
    // Replay history BEFORE responding — the client must suppress these.
    for (const u of this.script.loadReplayUpdates ?? []) {
      await this.conn.sessionUpdate({ sessionId: params.sessionId, update: u })
    }
    // Echo `availableModes` the same way newSession does (T2 for the resume
    // path: proves AcpEngine's `modeIdsFrom` capture on a LOADED session, not
    // just a freshly-created one).
    const ids = this.script.availableModes
    return ids ? { modes: { currentModeId: ids[0] ?? 'default', availableModes: ids.map((id) => ({ id, name: id })) } } : {}
  }

  setSessionMode(params: Parameters<NonNullable<Agent['setSessionMode']>>[0]): Record<string, never> {
    record({ event: 'setSessionMode', modeId: params.modeId })
    if (this.script.rejectSetSessionMode?.includes(params.modeId)) throw new Error(`fake: mode ${params.modeId} rejected`)
    return {}
  }

  setSessionConfigOption(
    params: Parameters<NonNullable<Agent['setSessionConfigOption']>>[0]
  ): { configOptions: never[] } {
    record({ event: 'setSessionConfigOption', configId: params.configId, value: params.value })
    return { configOptions: [] }
  }

  authenticate(): Record<string, never> {
    return {}
  }

  async prompt(params: Parameters<Agent['prompt']>[0]): Promise<PromptResponse> {
    const turn = this.script.turns[this.turnIndex] ?? {}
    this.turnIndex++
    const sessionId = params.sessionId
    const ac = new AbortController()
    this.aborters.add(ac)
    try {
      for (const u of turn.updates ?? []) {
        await this.conn.sessionUpdate({ sessionId, update: u })
      }

      let rejected = false
      const perms = turn.permissions ?? (turn.permission ? [turn.permission] : [])
      for (const p of perms) {
        const res = await this.conn.requestPermission({
          sessionId,
          toolCall: {
            toolCallId: p.toolCallId,
            ...(p.title !== undefined ? { title: p.title } : {}),
            kind: p.kind,
            status: 'pending',
            ...(p.rawInput !== undefined ? { rawInput: p.rawInput } : {})
          },
          ...(p.meta !== undefined ? { _meta: p.meta } : {}),
          options: p.options ?? DEFAULT_OPTIONS
        })
        record({ event: 'permissionOutcome', toolCallId: p.toolCallId, outcome: res.outcome })
        if (res.outcome.outcome === 'cancelled') {
          return { stopReason: 'cancelled' }
        }
        if (res.outcome.optionId === 'reject') rejected = true
      }

      if (turn.delayMs) await sleep(turn.delayMs, ac.signal)

      const text = rejected ? (turn.rejectedText ?? '') : (turn.text ?? '')
      if (text) {
        await this.conn.sessionUpdate({
          sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }
        })
      }
      return { stopReason: turn.stopReason ?? 'end_turn' }
    } catch (err) {
      if (ac.signal.aborted) return { stopReason: 'cancelled' }
      throw err
    } finally {
      this.aborters.delete(ac)
    }
  }

  cancel(): void {
    record({ event: 'cancel' })
    for (const ac of this.aborters) ac.abort()
  }
}

function main(): void {
  const raw = process.env.LIMN_FAKE_ACP_SCRIPT
  const script: FakeScript = raw ? (JSON.parse(raw) as FakeScript) : { turns: [] }
  const toClient = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>
  const fromClient = Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>
  const stream = ndJsonStream(toClient, fromClient)
  const connection = new AgentSideConnection((conn) => new FakeAgent(conn, script), stream)
  void connection // held for the lifetime of the process
}

// Only run as an agent when spawned as the entry file — never when imported for types.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main()
}
