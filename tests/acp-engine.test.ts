import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AcpEngine } from '../src/main/engines/acp'
import { CLAUDE_ACP_CONFIG } from '../src/main/engines/adapters'
import { resolveDecision, pendingCount } from '../src/main/engines/approvals'
import type { EngineEvent, ReviewAnnotations } from '../src/shared/types'
import type { FakeScript } from './helpers/fakeAcpAgent'

const FAKE_ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'helpers', 'fakeAcpAgent.ts')

const outFiles: string[] = []

/** Build an AcpEngine wired to the fake agent, injecting `script` via spawn env. */
function fakeEngine(script: FakeScript): { engine: AcpEngine; readRecords: () => Array<Record<string, unknown>> } {
  const outFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fake-acp-')), 'out.ndjson')
  outFiles.push(outFile)
  const engine = new AcpEngine({
    ...CLAUDE_ACP_CONFIG,
    adapterEntry: FAKE_ENTRY,
    env: (t) => ({
      ...(CLAUDE_ACP_CONFIG.env?.(t) ?? {}),
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
  sections: [{ id: 'a', name: 'A', desc: 'd', what: 'w', files: ['x.ts'], order: 1, diagram: null, insight: null, plainNotes: null }],
  planMap: null,
  questions: [],
  artifactPaths: null
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
    expect(value.title).toBe('T')
    expect(value.sections[0].id).toBe('a')
  })

  it('3a. repair turn: invalid JSON then valid → second prompt repairs', async () => {
    const { engine } = fakeEngine({
      sessionId: 'rev-2',
      turns: [{ text: 'not json at all' }, { text: JSON.stringify(validReview) }]
    })
    const run = engine.generateReview({ repo: '/r', branch: 'f', base: 'main', diff: { base: 'main', branch: 'f', files: [], mergeBase: 'a'.repeat(40), headSha: 'b'.repeat(40) }, artifacts: [] })
    await drain(run.events)
    const { value } = await run.result
    expect(value.title).toBe('T')
  })

  it('3b. repair turn: invalid twice → run rejects with error event', async () => {
    const { engine } = fakeEngine({
      sessionId: 'rev-3',
      turns: [{ text: 'nope' }, { text: 'still nope' }]
    })
    const run = engine.generateReview({ repo: '/r', branch: 'f', base: 'main', diff: { base: 'main', branch: 'f', files: [], mergeBase: 'a'.repeat(40), headSha: 'b'.repeat(40) }, artifacts: [] })
    const events = await drain(run.events)
    expect(events.some((e) => e.type === 'error')).toBe(true)
    await expect(run.result).rejects.toThrow()
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

  it('6. session/load failure → seeded fresh session, turn still completes', async () => {
    const { engine } = fakeEngine({
      sessionId: 'fresh-6',
      failLoad: true,
      turns: [{ text: 'answered fresh' }]
    })
    const run = engine.chat({ repo: '/r', engineSessionId: 'stale-id', message: 'hi' })
    await drain(run.events)
    const { value, sessionId } = await run.result
    expect(value).toBe('answered fresh')
    expect(sessionId).toBe('fresh-6') // the fresh id, not the failed resume id
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
        id: 's1', name: 'src', desc: 'd', what: 'w', files: ['src/a.ts', 'src/c.ts'], order: 1,
        diagram: null, insight: null, plainNotes: null
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
        { id: 's1', name: 'src', desc: 'd', what: 'w', files: ['src/a.ts'], order: 1 },
        { id: 's2', name: 'docs', desc: 'd', what: 'w', files: ['docs/x.md'], order: 2 }
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
})

/** Minimal poll helper (avoids importing vitest's fake timers). */
async function vi_waitFor(pred: () => boolean, timeoutMs = 10000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}
