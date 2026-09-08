import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AcpEngine } from '../src/server/engines/acp'
import { CancelledError, EngineSessionLostError } from '../src/server/engines/errors'
import { CLAUDE_ACP_CONFIG, CODEX_ACP_CONFIG } from '../src/server/engines/adapters'
import { resolveDecision, pendingCount } from '../src/server/engines/approvals'
import { setEngineBinaryPrefs } from '../src/server/engines/binaries'
import { ENGINE_PATH_PREF_KEYS } from '../src/shared/prefs'
import type { EngineEvent, ExecutionMode, ReviewAnnotations } from '../src/shared/types'
import type { AcpEngineConfig } from '../src/server/engines/adapters'
import type { FakeScript } from './helpers/fakeAcpAgent'

const FAKE_ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'helpers', 'fakeAcpAgent.ts')

const outFiles: string[] = []

/** Build an AcpEngine wired to the fake agent, injecting `script` via spawn env.
 *  Defaults to `CLAUDE_ACP_CONFIG`'s mode/configOptions behaviour; pass `baseConfig`
 *  (e.g. `CODEX_ACP_CONFIG`) to exercise a different engine's config against the fake. */
function fakeEngine(
  script: FakeScript,
  baseConfig: AcpEngineConfig = CLAUDE_ACP_CONFIG
): { engine: AcpEngine; readRecords: () => Array<Record<string, unknown>> } {
  const outFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fake-acp-')), 'out.ndjson')
  outFiles.push(outFile)
  const engine = new AcpEngine({
    ...baseConfig,
    adapterEntry: FAKE_ENTRY,
    binaryRequired: false, // the fake adapter needs no native engine binary
    env: (t) => ({
      ...(baseConfig.env?.(t) ?? {}),
      LIMN_FAKE_ACP_SCRIPT: JSON.stringify(script),
      LIMN_FAKE_ACP_OUT: outFile
    })
  })
  const readRecords = (): Array<Record<string, unknown>> =>
    fs.existsSync(outFile)
      ? fs.readFileSync(outFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
      : []
  return { engine, readRecords }
}

async function drain(events: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
  const out: EngineEvent[] = []
  for await (const e of events) out.push(e)
  return out
}

afterEach(() => {
  for (const f of outFiles.splice(0)) fs.rmSync(path.dirname(f), { recursive: true, force: true })
})

const validReview = {
  title: 'T',
  summary: 'S',
  sections: [{ id: 'a', name: 'A', narration: [{ text: 'w' }], files: ['x.ts'] }],
  planMap: null,
  questions: [],
  artifactPaths: null,
  hotspots: []
}

describe('AcpEngine e2e against FakeAcpAgent', () => {
  it('1. chat happy path: mapped events in order, done, value + sessionId', async () => {
    const { engine } = fakeEngine({
      sessionId: 'chat-1',
      turns: [{
        updates: [
          { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello ' } },
          { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read file', kind: 'read', status: 'pending', rawInput: { path: 'a.ts' } },
          { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', rawOutput: 'contents' }
        ],
        text: 'world'
      }]
    })
    const run = engine.chat({ repo: '/r', engineSessionId: 'chat-1', message: 'hi' })
    const events = await drain(run.events)
    const types = events.map((e) => e.type)
    expect(types).toContain('text')
    expect(types).toContain('tool')
    expect(types[types.length - 1]).toBe('done')
    // text comes before the tool event (stream order preserved)
    expect(types.indexOf('text')).toBeLessThan(types.indexOf('tool'))
    const { value, sessionId } = await run.result
    expect(value).toBe('Hello world')
    expect(sessionId).toBe('chat-1')
  })

  it('2. generateReview: streamed text suppressed, parsed annotations returned', async () => {
    const { engine } = fakeEngine({
      sessionId: 'rev-1',
      turns: [{ text: JSON.stringify(validReview) }]
    })
    const run = engine.generateReview({ repo: '/r', branch: 'f', base: 'main', diff: { base: 'main', branch: 'f', files: [], mergeBase: 'a'.repeat(40), headSha: 'b'.repeat(40) }, artifacts: [] })
    const events = await drain(run.events)
    expect(events.some((e) => e.type === 'text')).toBe(false) // suppressed
    const { value } = await run.result
    expect(value.annotations.title).toBe('T')
    expect(value.annotations.sections[0].id).toBe('a')
  })

  it('2b. generation turn auto-allows a command permission (even an unsafe one), without parking', async () => {
    const { engine, readRecords } = fakeEngine({
      sessionId: 'rev-gen-cmd',
      turns: [{
        permission: { toolCallId: 'gc1', title: 'run', kind: 'execute', rawInput: { command: 'npm install left-pad' } },
        text: JSON.stringify(validReview),
        rejectedText: 'denied — would fail parsing'
      }]
    })
    const run = engine.generateReview({ repo: '/r', branch: 'f', base: 'main', diff: { base: 'main', branch: 'f', files: [], mergeBase: 'a'.repeat(40), headSha: 'b'.repeat(40) }, artifacts: [] })
    const events = await drain(run.events)
    expect(events.some((e) => e.type === 'approval_request')).toBe(false) // no parking — generation has no opId
    const { value } = await run.result
    expect(value.annotations.title).toBe('T') // allow branch taken
    const records = readRecords()
    expect((records.find((r) => r.event === 'permissionOutcome')?.outcome as { optionId?: string })?.optionId).toBe('allow')
    // the session mode is the non-write one, so edits ask instead of auto-applying
    expect(records.find((r) => r.event === 'setSessionMode')?.modeId).toBe('default')
  })

  it('2c. generation turn auto-DENIES a file_change permission', async () => {
    const { engine, readRecords } = fakeEngine({
      sessionId: 'rev-gen-edit',
      turns: [{
        permission: { toolCallId: 'ge1', title: 'Edit file', kind: 'edit', rawInput: { path: '/r/a.ts' } },
        text: 'allowed — would fail parsing',
        rejectedText: JSON.stringify(validReview)
      }]
    })
    const run = engine.generateReview({ repo: '/r', branch: 'f', base: 'main', diff: { base: 'main', branch: 'f', files: [], mergeBase: 'a'.repeat(40), headSha: 'b'.repeat(40) }, artifacts: [] })
    const events = await drain(run.events)
    expect(events.some((e) => e.type === 'approval_request')).toBe(false) // denied outright, never parked
    const { value } = await run.result
    expect(value.annotations.title).toBe('T') // reject branch taken
    const outcome = readRecords().find((r) => r.event === 'permissionOutcome')
    expect((outcome?.outcome as { optionId?: string })?.optionId).toBe('reject')
  })

  it('3a. repair turn: invalid JSON then valid → second prompt repairs', async () => {
    const { engine } = fakeEngine({
      sessionId: 'rev-2',
      turns: [{ text: 'not json at all' }, { text: JSON.stringify(validReview) }]
    })
    const run = engine.generateReview({ repo: '/r', branch: 'f', base: 'main', diff: { base: 'main', branch: 'f', files: [], mergeBase: 'a'.repeat(40), headSha: 'b'.repeat(40) }, artifacts: [] })
    await drain(run.events)
    const { value } = await run.result
    expect(value.annotations.title).toBe('T')
  })

  it('3b. repair turn: invalid twice → rejects with an UNWRAPPED ZodError, no raw error event', async () => {
    // valid JSON but off-schema on both turns → parseReviewOutput throws a ZodError.
    const { engine } = fakeEngine({
      sessionId: 'rev-3',
      turns: [{ text: '{"wrong":1}' }, { text: '{"still":"wrong"}' }]
    })
    const run = engine.generateReview({ repo: '/r', branch: 'f', base: 'main', diff: { base: 'main', branch: 'f', files: [], mergeBase: 'a'.repeat(40), headSha: 'b'.repeat(40) }, artifacts: [] })
    const events = await drain(run.events)
    // NO raw {type:'error'} event — ipc.ts renders the friendly copy from the
    // rejection (the parse happens after the turn completes, not as part of it).
    expect(events.some((e) => e.type === 'error')).toBe(false)
    // the rejection preserves ZodError.name so ipc.ts's friendly-message gate fires.
    const err = await run.result.then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).name).toBe('ZodError')
  })

  it('4. approval park/resolve: unsafe command asks, allow completes; limn tool auto-allows', async () => {
    const { engine, readRecords } = fakeEngine({
      sessionId: 'ch-4',
      turns: [{
        permission: { toolCallId: 'cmd1', title: 'run', kind: 'execute', rawInput: { command: 'rm -rf /' } },
        text: 'done',
        rejectedText: 'skipped'
      }]
    })
    const run = engine.chat({ repo: '/r', engineSessionId: 'ch-4', message: 'go', opId: 'op4', executionMode: 'ask' })
    const events: EngineEvent[] = []
    let resolved = false
    for await (const e of run.events) {
      events.push(e)
      if (e.type === 'approval_request' && !resolved) {
        resolved = true
        expect(e.request.kind).toBe('command')
        resolveDecision('op4', e.request.id, 'allow')
      }
    }
    expect(resolved).toBe(true)
    const { value } = await run.result
    expect(value).toBe('done') // allow branch taken
    const outcome = readRecords().find((r) => r.event === 'permissionOutcome')
    expect((outcome?.outcome as { optionId?: string })?.optionId).toBe('allow')
  })

  it('4b. limn-tool permission at ask is auto-allowed (no approval event)', async () => {
    const { engine } = fakeEngine({
      sessionId: 'ch-4b',
      turns: [{
        permission: { toolCallId: 'lt1', title: 'mcp__limn__focus', kind: 'other', rawInput: {} },
        text: 'focused'
      }]
    })
    const run = engine.chat({ repo: '/r', engineSessionId: 'ch-4b', message: 'go', opId: 'op4b', executionMode: 'ask' })
    const events = await drain(run.events)
    expect(events.some((e) => e.type === 'approval_request')).toBe(false)
    const { value } = await run.result
    expect(value).toBe('focused')
  })

  it('4d. codex-style correlated MCP limn-tool approval (no title, _meta flag) auto-allows', async () => {
    // codex-acp sends MCP tool approvals as kind 'execute' with title/rawInput
    // omitted, flagged via _meta — the tool name must be recovered from the
    // initiating tool_call so the limn auto-allow fires (not a blank "Run ``" ask).
    const { engine, readRecords } = fakeEngine({
      sessionId: 'ch-4d',
      turns: [{
        updates: [
          { sessionUpdate: 'tool_call', toolCallId: 'mcp9', title: 'mcp.limn.add_comment', kind: 'other', status: 'pending' }
        ],
        permission: { toolCallId: 'mcp9', kind: 'execute', meta: { is_mcp_tool_approval: true } },
        text: 'noted',
        rejectedText: 'refused'
      }]
    }, CODEX_ACP_CONFIG)
    const run = engine.chat({ repo: '/r', engineSessionId: 'ch-4d', message: 'go', opId: 'op4d', executionMode: 'ask' })
    const events = await drain(run.events)
    expect(events.some((e) => e.type === 'approval_request')).toBe(false) // auto-allowed, never parked
    const { value } = await run.result
    expect(value).toBe('noted') // allow branch taken
    const outcome = readRecords().find((r) => r.event === 'permissionOutcome')
    expect((outcome?.outcome as { optionId?: string })?.optionId).toBe('allow')
  })

  it('4g. a deny picks reject_always when the adapter offers no reject_once — never the leading allow', async () => {
    // Adapters list their allow options FIRST, so a positional fallback would turn a
    // deny into an allow on any adapter that spells rejection `reject_always`.
    const { engine, readRecords } = fakeEngine({
      sessionId: 'ch-4g',
      turns: [{
        permission: {
          toolCallId: 'cmd4g',
          title: 'run',
          kind: 'execute',
          rawInput: { command: 'ls' },
          options: [
            { kind: 'allow_once', name: 'Allow', optionId: 'allow' },
            { kind: 'reject_always', name: 'Decline', optionId: 'reject' }
          ]
        },
        text: 'done',
        rejectedText: 'refused'
      }]
    })
    const run = engine.chat({ repo: '/r', engineSessionId: 'ch-4g', message: 'go', opId: 'op4g', executionMode: 'ask' })
    for await (const e of run.events) if (e.type === 'approval_request') resolveDecision('op4g', e.request.id, 'deny')
    const { value } = await run.result
    expect(value).toBe('refused') // reject branch taken
    const outcome = readRecords().find((r) => r.event === 'permissionOutcome')
    expect((outcome?.outcome as { optionId?: string })?.optionId).toBe('reject')
  })

  it('4h. a deny with no reject option at all answers `cancelled`, not the leading allow', async () => {
    const { engine, readRecords } = fakeEngine({
      sessionId: 'ch-4h',
      turns: [{
        permission: {
          toolCallId: 'cmd4h',
          title: 'run',
          kind: 'execute',
          rawInput: { command: 'ls' },
          options: [{ kind: 'allow_once', name: 'Allow', optionId: 'allow' }]
        },
        text: 'done',
        rejectedText: 'refused'
      }]
    })
    const run = engine.chat({ repo: '/r', engineSessionId: 'ch-4h', message: 'go', opId: 'op4h', executionMode: 'ask' })
    for await (const e of run.events) if (e.type === 'approval_request') resolveDecision('op4h', e.request.id, 'deny')
    // the fake stops the turn on a cancelled outcome → the engine's quiet cancel settle
    await expect(run.result).rejects.toBeInstanceOf(CancelledError)
    const outcome = readRecords().find((r) => r.event === 'permissionOutcome')
    expect(outcome?.outcome).toEqual({ outcome: 'cancelled' })
  })

  it('4i. an allow picks allow_always when the adapter offers no allow_once', async () => {
    const { engine, readRecords } = fakeEngine({
      sessionId: 'ch-4i',
      turns: [{
        permission: {
          toolCallId: 'lt4i',
          title: 'mcp__limn__focus',
          kind: 'other',
          rawInput: {},
          options: [
            { kind: 'allow_always', name: 'Always allow', optionId: 'allow' },
            { kind: 'reject_once', name: 'Reject', optionId: 'reject' }
          ]
        },
        text: 'focused'
      }]
    })
    const run = engine.chat({ repo: '/r', engineSessionId: 'ch-4i', message: 'go', opId: 'op4i', executionMode: 'ask' })
    await drain(run.events)
    expect(await run.result.then((r) => r.value)).toBe('focused')
    const outcome = readRecords().find((r) => r.event === 'permissionOutcome')
    expect((outcome?.outcome as { optionId?: string })?.optionId).toBe('allow')
  })

  it('4e. mid-turn ask→full: the SECOND file change is auto-allowed, never parked', async () => {
    // The tier is re-read (turn.currentMode) at EVERY permission request, so moving
    // the selector while a turn streams takes effect from the next request on.
    // Retargeted in T2: under the collapsed ladder only `full` auto-allows outright
    // (ask/edits/auto all park below full — the native-mode-selected auto is T2's job).
    const { engine, readRecords } = fakeEngine({
      sessionId: 'ch-4e',
      turns: [{
        permissions: [
          { toolCallId: 'e1', title: 'Edit file', kind: 'edit', rawInput: { path: '/r/a.ts' } },
          { toolCallId: 'e2', title: 'Edit file', kind: 'edit', rawInput: { path: '/r/b.ts' } }
        ],
        text: 'done',
        rejectedText: 'refused'
      }]
    })
    let tier: ExecutionMode = 'ask'
    const run = engine.chat({
      repo: '/r', engineSessionId: 'ch-4e', message: 'go', opId: 'op4e',
      writeEnabled: true, executionMode: 'ask', currentMode: () => tier
    })
    const approvals: EngineEvent[] = []
    for await (const e of run.events) {
      if (e.type === 'approval_request') {
        approvals.push(e)
        tier = 'full' // the reviewer flips the selector mid-turn, then answers
        resolveDecision('op4e', e.request.id, 'allow')
      }
    }
    expect(approvals.length).toBe(1) // only the FIRST request parked
    const { value } = await run.result
    expect(value).toBe('done')
    const outcomes = readRecords().filter((r) => r.event === 'permissionOutcome')
    expect(outcomes.map((r) => (r.outcome as { optionId?: string }).optionId)).toEqual(['allow', 'allow'])
  })

  it('4f. mid-turn full→ask: the SECOND file change parks even though the turn started at full', async () => {
    // Retargeted in T2: under the collapsed ladder only `full` allows a file_change
    // outright — 'auto' now parks like 'ask' does (the native-mode-selected auto,
    // where the engine itself decides what to surface, is T2's job).
    const { engine, readRecords } = fakeEngine({
      sessionId: 'ch-4f',
      turns: [{
        permissions: [
          { toolCallId: 'f1', title: 'Edit file', kind: 'edit', rawInput: { path: '/r/a.ts' } },
          { toolCallId: 'f2', title: 'Edit file', kind: 'edit', rawInput: { path: '/r/b.ts' } }
        ],
        text: 'done',
        rejectedText: 'refused'
      }]
    })
    // downgraded between the two requests: the first read still sees 'full' (allowed
    // outright, so there is no approval event to hook the flip onto), the second 'ask'.
    let tier: ExecutionMode = 'full'
    const run = engine.chat({
      repo: '/r', engineSessionId: 'ch-4f', message: 'go', opId: 'op4f',
      writeEnabled: true, executionMode: 'full',
      currentMode: () => { const t = tier; tier = 'ask'; return t }
    })
    const approvals: EngineEvent[] = []
    for await (const e of run.events) {
      if (e.type === 'approval_request') {
        approvals.push(e)
        resolveDecision('op4f', e.request.id, 'deny')
      }
    }
    expect(approvals.length).toBe(1) // only the SECOND request parked
    const { value } = await run.result
    expect(value).toBe('refused') // the parked request was denied
    const outcomes = readRecords().filter((r) => r.event === 'permissionOutcome')
    expect(outcomes.map((r) => (r.outcome as { optionId?: string }).optionId)).toEqual(['allow', 'reject'])
  })

  it('5. cancel → cancelled; pending permission cleared', async () => {
    const { engine } = fakeEngine({
      sessionId: 'ch-5',
      turns: [{ permission: { toolCallId: 'c5', title: 'run', kind: 'execute', rawInput: { command: 'sleep 999' } }, delayMs: 30000, text: 'never' }]
    })
    const run = engine.chat({ repo: '/r', engineSessionId: 'ch-5', message: 'go', opId: 'op5', executionMode: 'ask' })
    // wait for the approval to be parked, then cancel
    const seen: EngineEvent[] = []
    const reader = (async () => { for await (const e of run.events) seen.push(e) })()
    await vi_waitFor(() => seen.some((e) => e.type === 'approval_request'))
    expect(pendingCount('op5')).toBe(1)
    run.cancel()
    await expect(run.result).rejects.toThrow(/cancelled/i)
    await reader
    expect(pendingCount('op5')).toBe(0)
  })

  it('6. session/load failure rejects with the TYPED EngineSessionLostError (no unseeded fresh)', async () => {
    // A failed resume must NOT silently mint an unseeded fresh session (chat built a
    // non-seeded prompt) — it must reject with EngineSessionLostError so ipc.ts's
    // ENGINE_SESSION_LOST "start a new chat" affordance fires.
    const { engine } = fakeEngine({
      sessionId: 'should-not-be-used',
      failLoad: true,
      turns: [{ text: 'should never run' }]
    })
    const run = engine.chat({ repo: '/r', engineSessionId: 'stale-id', message: 'hi' })
    await drain(run.events)
    const err = await run.result.then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(EngineSessionLostError)
    expect((err as EngineSessionLostError).engineSessionId).toBe('stale-id')
  })

  it('6b. a MISSING loadSession capability is a systemic failure, NOT a lost session', async () => {
    // The adapter can't resume anything — the wrong remedy would be "start a new
    // chat"; this must stay a generic error (finding: no capability ≠ pruned session).
    const { engine } = fakeEngine({
      sessionId: 'unused',
      loadSession: false,
      turns: [{ text: 'should never run' }]
    })
    const run = engine.chat({ repo: '/r', engineSessionId: 'some-id', message: 'hi' })
    await drain(run.events)
    const err = await run.result.then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(EngineSessionLostError)
    expect((err as Error).message).toMatch(/cannot resume session/i)
  })

  it('5b. cancel rejects with the typed CancelledError (quiet settle)', async () => {
    const { engine } = fakeEngine({
      sessionId: 'ch-5b',
      turns: [{ delayMs: 30000, text: 'never' }]
    })
    const run = engine.chat({ repo: '/r', engineSessionId: 'ch-5b', message: 'go' })
    const resultErr = run.result.then(() => null, (e: unknown) => e)
    const reader = drain(run.events)
    await new Promise((r) => setTimeout(r, 50)) // let the turn get in flight
    run.cancel()
    expect(await resultErr).toBeInstanceOf(CancelledError)
    await reader
  })

  it('7. MCP url present: tools turn passes an http mcpServers entry to session/new', async () => {
    const { engine, readRecords } = fakeEngine({ sessionId: 'ch-7', turns: [{ text: 'ok' }] })
    const host = { call: async () => ({ result: 'ok', isError: false }) }
    const run = engine.chat({ repo: '/r', message: 'go', tools: host as never })
    await drain(run.events)
    await run.result
    const ns = readRecords().find((r) => r.event === 'newSession')
    const servers = ns?.mcpServers as Array<{ type: string; name: string; url: string }> | undefined
    expect(servers?.[0]?.type).toBe('http')
    expect(servers?.[0]?.name).toBe('limn')
    expect(servers?.[0]?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp\//)
  })

  it('8. replay suppression: updates replayed during session/load are not emitted', async () => {
    const { engine } = fakeEngine({
      sessionId: 'unused',
      loadSession: true,
      loadReplayUpdates: [
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OLD HISTORY' } },
        { sessionUpdate: 'tool_call', toolCallId: 'old', title: 'old', kind: 'read', status: 'completed' }
      ],
      turns: [{ text: 'live answer' }]
    })
    const run = engine.chat({ repo: '/r', engineSessionId: 'resume-me', message: 'hi' })
    const events = await drain(run.events)
    const texts = events.filter((e): e is Extract<EngineEvent, { type: 'text' }> => e.type === 'text').map((e) => e.text)
    expect(texts.join('')).not.toContain('OLD HISTORY')
    const { value, sessionId } = await run.result
    expect(value).toBe('live answer')
    expect(sessionId).toBe('resume-me') // loaded, not fresh
  })

  it('9. generateScopedUpdate: parsed ScopedReviewPatch returned, resuming priorEngineSessionId', async () => {
    const validScopedPatch = {
      title: null,
      summary: null,
      revisedSections: [{
        id: 's1', name: 'src', narration: [{ text: 'w' }], files: ['src/a.ts', 'src/c.ts']
      }],
      deletedSectionIds: [],
      keptSectionIds: ['s2'],
      newQuestions: [],
      resolvedQuestionIds: [],
      planMap: null
    }
    const { engine, readRecords } = fakeEngine({
      sessionId: 'unused-scoped',
      turns: [{ text: JSON.stringify(validScopedPatch) }]
    })
    const prior: ReviewAnnotations = {
      title: 'Prior title',
      summary: 'Prior summary',
      sections: [
        { id: 's1', name: 'src', narration: [{ text: 'w' }], files: ['src/a.ts'] },
        { id: 's2', name: 'docs', narration: [{ text: 'w' }], files: ['docs/x.md'] }
      ],
      questions: []
    }
    const run = engine.generateScopedUpdate({
      repo: '/r', branch: 'feature', base: 'main', sinceSha: 'a'.repeat(40),
      since: [{ path: 'src/c.ts', status: 'added', binary: false, add: 1, del: 0, hunks: [] }],
      prior,
      priorEngineSessionId: 'sess-prior'
    })
    await drain(run.events)
    const { value, sessionId } = await run.result
    expect(value).toEqual(validScopedPatch)
    expect(sessionId).toBe('sess-prior') // resumed, not minted fresh
    const load = readRecords().find((r) => r.event === 'loadSession')
    expect(load?.sessionId).toBe('sess-prior')
  })

  it('10. protocol-version guard (OQ10): mismatched protocolVersion fails the turn with an actionable error', async () => {
    const { engine } = fakeEngine({
      sessionId: 'proto-mismatch',
      protocolVersion: 2,
      turns: [{ text: 'unused — the turn must fail before prompting' }]
    })
    const run = engine.chat({ repo: '/r', message: 'hi' })
    const events = await drain(run.events)
    const errorEvent = events.find((e): e is Extract<EngineEvent, { type: 'error' }> => e.type === 'error')
    expect(errorEvent).toBeTruthy()
    expect(errorEvent?.message).toMatch(/protocol/i)
    await expect(run.result).rejects.toThrow(/protocol/i)
  })

  it('11. Codex config: model + reasoning_effort applied via setSessionConfigOption (no ANTHROPIC_MODEL env)', async () => {
    const { engine, readRecords } = fakeEngine({ sessionId: 'codex-1', turns: [{ text: 'ok' }] }, CODEX_ACP_CONFIG)
    const run = engine.chat({ repo: '/r', message: 'go', model: 'gpt-5.5', reasoningEffort: 'max' })
    await drain(run.events)
    await run.result
    const optionCalls = readRecords().filter((r) => r.event === 'setSessionConfigOption')
    expect(optionCalls).toEqual(
      expect.arrayContaining([
        { event: 'setSessionConfigOption', configId: 'model', value: 'gpt-5.5' },
        { event: 'setSessionConfigOption', configId: 'reasoning_effort', value: 'xhigh' } // max clamps to xhigh
      ])
    )
    // Codex has no model spawn env — the fake's env only carries the test-harness keys.
    expect(optionCalls.length).toBe(2)
  })

  it('12. binaryRequired: an unresolved native binary fails the turn before spawn with the status hint', async () => {
    // Codex hard-requires its binary (bundled fallback stripped from the package); an
    // invalid configured path must surface as a turn error, not an adapter crash.
    setEngineBinaryPrefs({ [ENGINE_PATH_PREF_KEYS.codex]: '/no/such/codex' })
    try {
      const engine = new AcpEngine({ ...CODEX_ACP_CONFIG, adapterEntry: FAKE_ENTRY })
      const run = engine.chat({ repo: '/r', message: 'go' })
      const events = await drain(run.events)
      expect(events.at(-1)).toMatchObject({ type: 'error' })
      await expect(run.result).rejects.toThrow()
    } finally {
      setEngineBinaryPrefs({})
    }
  })

  it('12b. a BROKEN Claude path override fails the turn with the Settings hint, not a raw adapter error', async () => {
    // Claude self-discovers its binary, so it has no `binaryRequired` gate — but a
    // configured override is handed to the adapter verbatim, so a stale one must
    // fail fast with the same actionable hint Settings shows.
    setEngineBinaryPrefs({ [ENGINE_PATH_PREF_KEYS.claude]: '/no/such/claude' })
    try {
      const engine = new AcpEngine({ ...CLAUDE_ACP_CONFIG, adapterEntry: FAKE_ENTRY })
      const run = engine.chat({ repo: '/r', message: 'go' })
      const events = await drain(run.events)
      expect(events.at(-1)).toMatchObject({ type: 'error' })
      await expect(run.result).rejects.toThrow('Configured path does not exist or is not executable.')
    } finally {
      setEngineBinaryPrefs({})
    }
  })

  it('12c. Claude with NO override still runs when the binary is unresolvable — the adapter self-discovers', async () => {
    const originalPath = process.env.PATH
    process.env.PATH = ''
    try {
      const { engine } = fakeEngine({ sessionId: 'ch-12c', turns: [{ text: 'ok' }] })
      const run = engine.chat({ repo: '/r', engineSessionId: 'ch-12c', message: 'go' })
      await drain(run.events)
      expect((await run.result).value).toBe('ok')
    } finally {
      process.env.PATH = originalPath
    }
  })

  it('13. auto tier selects the native "auto" mode when the session advertises it', async () => {
    const { engine, readRecords } = fakeEngine({
      sessionId: 'chat-auto',
      availableModes: ['default', 'acceptEdits', 'auto', 'bypassPermissions'],
      turns: [{ text: 'ok' }]
    })
    const run = engine.chat({ repo: '/r', message: 'go', writeEnabled: true, executionMode: 'auto' })
    await drain(run.events)
    await run.result
    expect(readRecords().find((r) => r.event === 'setSessionMode')?.modeId).toBe('auto')
  })

  it('14. auto tier falls back to acceptEdits when the session-advertised modes lack "auto"', async () => {
    const { engine, readRecords } = fakeEngine({
      sessionId: 'chat-auto-fallback',
      availableModes: ['default', 'acceptEdits', 'bypassPermissions'],
      turns: [{ text: 'ok' }]
    })
    const run = engine.chat({ repo: '/r', message: 'go', writeEnabled: true, executionMode: 'auto' })
    await drain(run.events)
    await run.result
    expect(readRecords().find((r) => r.event === 'setSessionMode')?.modeId).toBe('acceptEdits')
  })

  it('14b. a RESUMED session (session/load) under tier auto falls back to acceptEdits when the LOADED session\'s modes lack "auto"', async () => {
    // engineSessionId set -> acp.ts takes the resume path (canLoad, since this
    // script advertises no `resume` capability) and calls conn.loadSession(),
    // whose `modes` must feed the same modeIdsFrom capture as a fresh
    // session/new (T2, tests 13/14) — previously untested, since the fake's
    // loadSession never echoed availableModes. Asserting the
    // fallback (not "auto") is what actually pins the capture: with
    // availableModes advertising "auto", modeFor's optimistic default for an
    // UNKNOWN session (no modes captured at all) is ALSO "auto" — so only the
    // fallback case can fail if the load path drops the session's modes.
    const { engine, readRecords } = fakeEngine({
      sessionId: 'unused',
      loadSession: true,
      availableModes: ['default', 'acceptEdits', 'bypassPermissions'],
      turns: [{ text: 'ok' }]
    })
    const run = engine.chat({ repo: '/r', engineSessionId: 'resume-auto', message: 'go', writeEnabled: true, executionMode: 'auto' })
    await drain(run.events)
    const { sessionId } = await run.result
    expect(sessionId).toBe('resume-auto') // loaded, not fresh
    expect(readRecords().find((r) => r.event === 'setSessionMode')?.modeId).toBe('acceptEdits')
  })

  it('15. a rejected setSessionMode retries once with the tier\'s fallback id, and the turn still completes', async () => {
    const { engine, readRecords } = fakeEngine({
      sessionId: 'chat-mode-retry',
      // no availableModes advertised -> modeFor optimistically tries 'auto'; the fake
      // rejects it, so acp.ts must retry with modeFor's fallback ('acceptEdits').
      rejectSetSessionMode: ['auto'],
      turns: [{ text: 'ok' }]
    })
    const run = engine.chat({ repo: '/r', message: 'go', writeEnabled: true, executionMode: 'auto' })
    const events = await drain(run.events)
    expect(events.some((e) => e.type === 'error')).toBe(false)
    const { value } = await run.result
    expect(value).toBe('ok')
    const modeAttempts = readRecords().filter((r) => r.event === 'setSessionMode').map((r) => r.modeId)
    expect(modeAttempts).toEqual(['auto', 'acceptEdits']) // rejected once, then the fallback succeeded
    expect(events.some((e) => e.type === 'status' && /mode/i.test(e.text))).toBe(false) // fallback succeeded — no note needed
  })

  it("16. when BOTH the primary and fallback session mode are rejected, the turn still completes with a status note (no silent degradation)", async () => {
    const { engine, readRecords } = fakeEngine({
      sessionId: 'chat-mode-retry-both-fail',
      rejectSetSessionMode: ['auto', 'acceptEdits'],
      turns: [{ text: 'ok' }]
    })
    const run = engine.chat({ repo: '/r', message: 'go', writeEnabled: true, executionMode: 'auto' })
    const events = await drain(run.events)
    expect(events.some((e) => e.type === 'error')).toBe(false)
    const { value } = await run.result
    expect(value).toBe('ok') // the turn is not failed by a mode-set rejection
    const modeAttempts = readRecords().filter((r) => r.event === 'setSessionMode').map((r) => r.modeId)
    expect(modeAttempts).toEqual(['auto', 'acceptEdits'])
    // forward-compat note, at debug/status level, not a hard turn error.
    expect(events.some((e) => e.type === 'status' && /mode/i.test(e.text))).toBe(true)
  })
  it('17. beforePrompt sees the session\'s command list before anything is sent; a throw refuses the turn with no prompt', async () => {
    const { engine, readRecords } = fakeEngine({ turns: [{ text: 'should never stream' }], availableCommands: ['simplify', 'compact'] })
    const seen: (string[] | null)[] = []
    const run = engine.chat({
      repo: '/tmp', message: '/simplify',
      beforePrompt: (commands) => { seen.push(commands); throw new Error('Simplify is not installed for Claude') }
    })
    const [events, err] = await Promise.all([drain(run.events), run.result.catch((e: Error) => e)])
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain('not installed')
    expect(seen).toEqual([['simplify', 'compact']])
    expect(events.some((e) => e.type === 'text')).toBe(false)
    expect(readRecords().map((r) => r.event)).not.toContain('prompt')
  })

  it('17b. beforePrompt gets null when no list arrives within the wait, and the prompt still goes out', async () => {
    const { engine, readRecords } = fakeEngine({ turns: [{ text: 'hi' }] })
    const seen: (string[] | null)[] = []
    const run = engine.chat({ repo: '/tmp', message: 'hello', beforePrompt: (c) => { seen.push(c) }, commandsWaitMs: 200 })
    await drain(run.events)
    await run.result
    expect(seen).toEqual([null])
    expect(readRecords().map((r) => r.event)).toContain('prompt')
  })
})

/** Minimal poll helper (avoids importing vitest's fake timers). */
async function vi_waitFor(pred: () => boolean, timeoutMs = 10000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}
