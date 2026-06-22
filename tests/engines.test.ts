import { describe, it, expect, beforeAll, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeFixtureRepo, type FixtureRepo } from './helpers/fixtureRepo'
import { getDiff, diffSince, markSince, headSha } from '../src/main/git'
import { mergeAnnotations } from '../src/main/engines/validate'
import { FakeEngine } from '../src/main/engines/fake'
import { toEvents, makeCanUseTool, toApprovalRequest } from '../src/main/engines/claude'
import { resolveDecision } from '../src/main/engines/approvals'
import { createToolHost } from '../src/main/engines/tools'
import { openDb } from '../src/main/db/db'
import { createSession, createChatThread, upsertComment, loadReviewState } from '../src/main/db/sessions'
import type { Comment, EngineEvent, RefPair } from '../src/shared/types'

let fx: FixtureRepo
beforeAll(() => {
  fx = makeFixtureRepo()
})

async function drain(events: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
  const out: EngineEvent[] = []
  for await (const e of events) out.push(e)
  return out
}

describe('mergeAnnotations', () => {
  it('drops unknown files and creates Other changes', async () => {
    const sk = await getDiff(fx.dir, 'main', 'feature')
    const raw = {
      title: 't', summary: 's',
      sections: [
        { id: 'a', name: 'A', desc: 'd', what: 'w', files: ['src/a.ts', 'src/NOPE.ts'], order: 1 }
      ],
      questions: []
    }
    const { annotations, warnings } = mergeAnnotations(sk, raw)
    expect(warnings.some((w) => w.includes('NOPE'))).toBe(true)
    const other = annotations.sections.find((s) => s.id === 'other-changes')!
    expect(other).toBeTruthy()
    const all = annotations.sections.flatMap((s) => s.files).sort()
    expect(all).toEqual(sk.files.map((f) => f.path).sort())
    expect(new Set(all).size).toBe(all.length) // exactly once each
  })
})

describe('FakeEngine contract', () => {
  it('full cycle: review → comment → batch turn → since-tagging', async () => {
    const engine = new FakeEngine()
    const sk = await getDiff(fx.dir, 'main', 'feature')
    const reviewedAt = sk.headSha

    const run = engine.generateReview({ repo: fx.dir, branch: 'feature', base: 'main', diff: sk, artifacts: [] })
    const events = await drain(run.events)
    expect(events.some((e) => e.type === 'status')).toBe(true)
    const { value: raw, sessionId } = await run.result
    expect(sessionId).toBeTruthy()

    const { annotations } = mergeAnnotations(sk, raw)
    const all = annotations.sections.flatMap((s) => s.files).sort()
    expect(all).toEqual(sk.files.map((f) => f.path).sort())

    // a queued comment on a diff line of src/a.ts, sent into the unified batch turn
    const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'limn-batch-')), 'db')).db
    const branchPair: RefPair = {
      base: { kind: 'branch', symbol: 'main', anchorSha: 'a'.repeat(40) },
      compare: { kind: 'branch', symbol: 'feature', anchorSha: 'b'.repeat(40) }
    }
    const s = createSession(db, fx.dir, branchPair, { engine: 'claude' })
    const t = createChatThread(db, s.id, { kind: 'user', agent: { engine: 'claude' } })
    const comment: Comment = {
      id: 'c1',
      anchor: { kind: 'diff', file: 'src/a.ts', side: 'new', line: 2, hunkRange: '@@ -1,4 +1,5 @@', lineContent: '  return 2' },
      author: 'user', text: 'Please log this', status: 'sent', replies: [], createdAt: 'now', iteration: 1
    }
    upsertComment(db, s.id, comment)
    const host = createToolHost({
      db, sessionId: s.id, threadId: t.id, opId: 'o', repo: fx.dir,
      agent: { engine: 'claude' }, writeEnabled: true, engineSessionId: 'e1', emit: () => {}
    })
    const batch = engine.chat({ repo: fx.dir, message: 'handle the comments', tools: host, writeEnabled: true })
    await drain(batch.events)
    await batch.result

    // the agent resolved the comment + recorded an iteration via commit_changes
    const st = loadReviewState(db, s.id)
    expect(st.comments.find((c) => c.id === 'c1')!.status).toBe('resolved')
    expect(st.iterations.length).toBeGreaterThan(0)

    // a new commit exists on the branch
    const newHead = await headSha(fx.dir, 'feature')
    expect(newHead).not.toBe(reviewedAt)

    // re-diff and tag since-approved
    const full2 = await getDiff(fx.dir, 'main', 'feature')
    const since = await diffSince(fx.dir, reviewedAt, 'feature')
    markSince(full2, since)
    const a2 = full2.files.find((f) => f.path === 'src/a.ts')!
    const sinceTexts = a2.hunks.flatMap((h) => h.lines.filter((l) => l.since).map((l) => l.text))
    expect(sinceTexts).toContain('// addressed by agent')
  })

  it('chat returns streamed text and echoes the question', async () => {
    const engine = new FakeEngine()
    const run = engine.chat({ repo: fx.dir, engineSessionId: 'sess', message: 'why?' })
    const events = await drain(run.events)
    expect(events.some((e) => e.type === 'text')).toBe(true)
    const { value, sessionId } = await run.result
    expect(value).toContain('why?')
    expect(sessionId).toBe('sess') // resumes the given session
  })

  it('chat without a session id mints a fresh engine session', async () => {
    const engine = new FakeEngine()
    const run = engine.chat({ repo: fx.dir, message: 'hi', model: 'opus', context: { base: 'main', branch: 'feature' } })
    await drain(run.events)
    const { value, sessionId } = await run.result
    expect(sessionId).toBeTruthy()
    expect(sessionId).not.toBe('sess')
    expect(value).toContain('opus') // model surfaced in the demo answer
  })
})

describe('FakeEngine approval round-trip', () => {
  it('parks on an approval_request and resumes when the decision arrives', async () => {
    const run = new FakeEngine().chat({ repo: '/r', message: 'fix it [approve]', opId: 'opF' })
    const iter = run.events[Symbol.asyncIterator]()
    const seen: EngineEvent[] = []
    for (;;) {
      const { value, done } = await iter.next()
      if (done) break
      seen.push(value)
      if (value.type === 'approval_request') {
        expect(value.request).toMatchObject({ id: 'fake-1', kind: 'command', summary: 'Run `npm test`' })
        resolveDecision('opF', value.request.id, 'allow')
      }
    }
    await run.result
    expect(seen.some((e) => e.type === 'approval_request')).toBe(true)
    expect(seen.some((e) => e.type === 'status' && e.text.includes('approved'))).toBe(true)
  })

  it('reflects a deny decision', async () => {
    const run = new FakeEngine().chat({ repo: '/r', message: 'fix it [approve]', opId: 'opD' })
    const iter = run.events[Symbol.asyncIterator]()
    const seen: EngineEvent[] = []
    for (;;) {
      const { value, done } = await iter.next()
      if (done) break
      seen.push(value)
      if (value.type === 'approval_request') resolveDecision('opD', value.request.id, 'deny')
    }
    await run.result
    expect(seen.some((e) => e.type === 'status' && e.text.includes('denied'))).toBe(true)
  })
})

describe('claude canUseTool policy', () => {
  it('auto-allows limn + read-safe tools without prompting', async () => {
    const emit = vi.fn()
    const can = makeCanUseTool('opC', emit)
    expect(await can('mcp__limn__add_comment', {}, {} as never)).toEqual({ behavior: 'allow' })
    expect(await can('Read', { file_path: 'a' }, {} as never)).toEqual({ behavior: 'allow' })
    expect(await can('Grep', { pattern: 'x' }, {} as never)).toEqual({ behavior: 'allow' })
    expect(emit).not.toHaveBeenCalled()
  })

  it('prompts for Bash and routes a deny', async () => {
    const emit = vi.fn()
    const can = makeCanUseTool('opC2', emit)
    const p = can('Bash', { command: 'rm -rf x' }, {} as never)
    const ev = emit.mock.calls[0][0] as { type: string; request: { id: string; kind: string } }
    expect(ev.type).toBe('approval_request')
    expect(ev.request.kind).toBe('command')
    resolveDecision('opC2', ev.request.id, 'deny')
    expect(await p).toMatchObject({ behavior: 'deny' })
  })

  it('allows a write tool when approved', async () => {
    const emit = vi.fn()
    const can = makeCanUseTool('opC3', emit)
    const p = can('Edit', { file_path: 'src/a.ts' }, {} as never)
    const ev = emit.mock.calls[0][0] as { request: { id: string } }
    resolveDecision('opC3', ev.request.id, 'allow')
    expect(await p).toEqual({ behavior: 'allow' })
  })

  it('toApprovalRequest maps tool → kind/detail', () => {
    expect(toApprovalRequest('bash', 'Bash', { command: 'ls' }, 'r1')).toMatchObject({ kind: 'command', detail: { command: 'ls' } })
    expect(toApprovalRequest('e', 'Write', { file_path: 'a.ts' }, 'r2')).toMatchObject({ kind: 'file_change', detail: { files: ['a.ts'] } })
    expect(toApprovalRequest('w', 'WebFetch', { url: 'x' }, 'r3')).toMatchObject({ kind: 'tool_use', detail: { toolName: 'WebFetch' } })
  })
})

describe('claude toEvents — tool lifecycle', () => {
  it('maps a tool_use block to a running ToolCall', () => {
    const msg = { type: 'assistant', message: { content: [
      { type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: 'src/a.ts' } },
    ] } } as never
    expect(toEvents(msg)).toEqual([
      { type: 'tool', call: { id: 'tu_1', verb: 'read', name: 'Read', arg: 'src/a.ts', kv: [['file_path', 'src/a.ts']], state: 'run' } },
    ])
  })

  it('maps a tool_result user message to ok with out', () => {
    const msg = { type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: 'tu_1', content: 'line1\nline2\nline3', is_error: false },
    ] } } as never
    expect(toEvents(msg)).toEqual([
      { type: 'tool', call: { id: 'tu_1', verb: 'other', name: '', state: 'ok', out: 'line1\nline2\nline3' } },
    ])
  })

  it('marks an errored tool_result as err', () => {
    const msg = { type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: 'tu_2', content: 'boom', is_error: true },
    ] } } as never
    expect(toEvents(msg)[0]).toMatchObject({ type: 'tool', call: { id: 'tu_2', state: 'err', out: 'boom' } })
  })

  it('handles array-form tool_result content', () => {
    const msg = { type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: 'tu_3', content: [{ type: 'text', text: 'hello' }] },
    ] } } as never
    expect(toEvents(msg)[0]).toMatchObject({ type: 'tool', call: { id: 'tu_3', state: 'ok', out: 'hello' } })
  })

  it('emits assistant text and [] for unrelated messages', () => {
    expect(toEvents({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } } as never)).toEqual([{ type: 'text', text: 'hi' }])
    expect(toEvents({ type: 'system', subtype: 'other' } as never)).toEqual([])
  })

  it('emits multiple events from one assistant message (text + tool_use)', () => {
    const msg = { type: 'assistant', message: { content: [
      { type: 'text', text: 'looking' },
      { type: 'tool_use', id: 'tu_9', name: 'Grep', input: { pattern: 'foo' } },
    ] } } as never
    expect(toEvents(msg)).toEqual([
      { type: 'text', text: 'looking' },
      { type: 'tool', call: { id: 'tu_9', verb: 'grep', name: 'Grep', arg: 'foo', kv: [['pattern', 'foo']], state: 'run' } },
    ])
  })
})
