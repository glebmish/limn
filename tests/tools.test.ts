import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { createToolHost, LIMN_TOOLS, limnAllowedToolNames, type ToolHostCtx } from '../src/main/engines/tools'
import { FakeEngine } from '../src/main/engines/fake'
import { openDb } from '../src/main/db/db'
import { createSession, createChatThread, upsertComment, loadReviewState, updateSessionMeta } from '../src/main/db/sessions'
import type { AgentAction, Comment, EngineEvent, RefPair, ReviewAnnotations } from '../src/shared/types'

function makeCtx(over: Partial<ToolHostCtx> = {}): { ctx: ToolHostCtx; events: EngineEvent[] } {
  const events: EngineEvent[] = []
  const ctx: ToolHostCtx = {
    db: null as never,
    sessionId: 1,
    threadId: 7,
    opId: 'op-1',
    repo: '/tmp/repo',
    agent: { engine: 'claude' },
    emit: (e) => events.push(e),
    ...over
  }
  return { ctx, events }
}

function actionEvents(events: EngineEvent[]): AgentAction[] {
  return events.filter((e): e is Extract<EngineEvent, { type: 'action' }> => e.type === 'action').map((e) => e.action)
}

const ALL_TOOLS = ['add_comment', 'edit_review', 'focus', 'get_review', 'list_comments', 'reply_to_comment', 'resolve_comment', 'suggest_mark_viewed', 'tour']
const mcp = (n: string): string => `mcp__limn__${n}`

describe('LIMN_TOOLS catalog', () => {
  it('exposes the focus/suggest + comment/review tools (no write tool — commits go through git)', () => {
    expect(LIMN_TOOLS.map((t) => t.name).sort()).toEqual([...ALL_TOOLS].sort())
    for (const t of LIMN_TOOLS) {
      expect(t.description.length).toBeGreaterThan(0)
      expect(typeof t.input).toBe('object')
    }
  })

  it('exposes all limn tools (no limn write tool to withhold)', () => {
    expect(limnAllowedToolNames().sort()).toEqual(ALL_TOOLS.map(mcp).sort())
  })
})

describe('createToolHost — focus', () => {
  it('focuses a diff line, emitting + collecting the action', async () => {
    const { ctx, events } = makeCtx()
    const host = createToolHost(ctx)
    const { result, isError, action } = await host.call('focus', {
      target: { kind: 'diff', file: 'src/auth/jwt.ts', side: 'new', line: 31 }
    })
    expect(isError).toBeFalsy()
    expect(result).toContain('jwt.ts')
    expect(action).toEqual({
      kind: 'focus',
      anchor: { kind: 'diff', file: 'src/auth/jwt.ts', side: 'new', line: 31, hunkRange: '', lineContent: '' }
    })
    expect(actionEvents(events)).toEqual([action])
    expect(host.collected()).toEqual([action])
  })

  it('focuses the summary and a section', async () => {
    const { ctx } = makeCtx()
    const host = createToolHost(ctx)
    const a = await host.call('focus', { target: { kind: 'summary' } })
    const b = await host.call('focus', { target: { kind: 'section', sectionId: 's2' } })
    expect(a.action).toEqual({ kind: 'focus', anchor: { kind: 'summary' } })
    expect(b.action).toEqual({ kind: 'focus', anchor: { kind: 'section', sectionId: 's2' } })
    expect(host.collected()).toEqual([a.action, b.action])
  })

  it('rejects malformed input without emitting or collecting', async () => {
    const { ctx, events } = makeCtx()
    const host = createToolHost(ctx)
    const { isError, action } = await host.call('focus', { target: { kind: 'diff' } })
    expect(isError).toBe(true)
    expect(action).toBeUndefined()
    expect(events).toEqual([])
    expect(host.collected()).toEqual([])
  })
})

describe('createToolHost — tour', () => {
  it('creates a multi-stop walkthrough, emitting + collecting the action', async () => {
    const { ctx, events } = makeCtx()
    const host = createToolHost(ctx)
    const { result, isError, action } = await host.call('tour', {
      stops: [
        { target: { kind: 'diff', file: 'src/auth/jwt.ts', side: 'new', line: 31 }, note: '  new guard  ' },
        { target: { kind: 'section', sectionId: 's2' } }
      ],
      loop: true
    })
    const expected: AgentAction = {
      kind: 'tour',
      stops: [
        {
          target: { kind: 'diff', file: 'src/auth/jwt.ts', side: 'new', line: 31, hunkRange: '', lineContent: '' },
          note: 'new guard'
        },
        { target: { kind: 'section', sectionId: 's2' } }
      ],
      loop: true
    }
    expect(isError).toBeFalsy()
    expect(result).toContain('2-stop walkthrough')
    expect(action).toEqual(expected)
    expect(actionEvents(events)).toEqual([expected])
    expect(host.collected()).toEqual([expected])
  })

  it('rejects malformed tours without emitting or collecting', async () => {
    const { ctx, events } = makeCtx()
    const host = createToolHost(ctx)
    const oneStop = await host.call('tour', { stops: [{ target: { kind: 'summary' } }] })
    const badStop = await host.call('tour', {
      stops: [
        { target: { kind: 'summary' } },
        { target: { kind: 'diff' } }
      ]
    })
    expect(oneStop.isError).toBe(true)
    expect(badStop.isError).toBe(true)
    expect(events).toEqual([])
    expect(host.collected()).toEqual([])
  })
})

describe('createToolHost — suggest_mark_viewed', () => {
  it('emits a suggestion (no side effect) and collects it', async () => {
    const { ctx, events } = makeCtx()
    const host = createToolHost(ctx)
    const { result, isError, action } = await host.call('suggest_mark_viewed', {
      files: ['src/auth/jwt.ts'],
      note: 'looks fully understood'
    })
    expect(isError).toBeFalsy()
    expect(result.length).toBeGreaterThan(0)
    expect(action).toMatchObject({ kind: 'suggest_viewed', files: ['src/auth/jwt.ts'], note: 'looks fully understood' })
    expect(action?.kind === 'suggest_viewed' && typeof action.id).toBe('string') // stamped for the dismiss-persist path
    expect(actionEvents(events)).toEqual([action])
    expect(host.collected()).toEqual([action])
  })

  it('supports sectionIds and requires at least one target', async () => {
    const { ctx } = makeCtx()
    const host = createToolHost(ctx)
    const ok = await host.call('suggest_mark_viewed', { sectionIds: ['s1'] })
    expect(ok.action).toMatchObject({ kind: 'suggest_viewed', sectionIds: ['s1'] })
    const empty = await host.call('suggest_mark_viewed', {})
    expect(empty.isError).toBe(true)
  })
})

describe('createToolHost — dispatch', () => {
  it('errors on an unknown tool', async () => {
    const { ctx } = makeCtx()
    const host = createToolHost(ctx)
    const { isError } = await host.call('not_a_tool', {})
    expect(isError).toBe(true)
  })
})

describe('FakeEngine chat drives the tool host', () => {
  it('emits scripted focus + suggestion actions through the host', async () => {
    const { ctx, events } = makeCtx()
    const host = createToolHost(ctx)
    const engine = new FakeEngine()
    const run = engine.chat({ repo: '/tmp/repo', message: 'where is the JWT parsed?', tools: host })
    for await (const _ of run.events) { /* drain */ }
    await run.result
    const kinds = actionEvents(events).map((a) => a.kind)
    expect(kinds).toContain('focus')
    expect(kinds).toContain('tour')
    expect(kinds).toContain('suggest_viewed')
    expect(host.collected().map((a) => a.kind)).toEqual(kinds)
  })

  it('emits no actions when no tool host is supplied', async () => {
    const engine = new FakeEngine()
    const run = engine.chat({ repo: '/tmp/repo', message: 'hi' })
    const seen: EngineEvent[] = []
    for await (const e of run.events) seen.push(e)
    await run.result
    expect(actionEvents(seen)).toEqual([])
  })
})

describe('comment tools (real temp DB)', () => {
  const pair: RefPair = {
    base: { kind: 'branch', symbol: 'main', anchorSha: 'a'.repeat(40) },
    compare: { kind: 'branch', symbol: 'feature', anchorSha: 'b'.repeat(40) }
  }
  const userComment: Comment = {
    id: 'u1',
    anchor: { kind: 'diff', file: 'src/a.ts', side: 'new', line: 2, hunkRange: '@@', lineContent: '  return 2' },
    author: 'user', text: 'log this', status: 'queued', replies: [], createdAt: 'now', iteration: 0
  }

  function setup(): { db: DatabaseSync; ctx: ToolHostCtx; events: EngineEvent[]; sessionId: number; threadId: number } {
    const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'limn-tool-')), 'db')).db
    const s = createSession(db, '/repo', pair, { engine: 'claude' })
    const t = createChatThread(db, s.id, { kind: 'user', agent: { engine: 'claude', model: 'opus' } })
    upsertComment(db, s.id, userComment)
    const events: EngineEvent[] = []
    const ctx: ToolHostCtx = {
      db, sessionId: s.id, threadId: t.id, opId: 'o', repo: '/repo',
      agent: { engine: 'claude', model: 'opus' }, emit: (e) => events.push(e)
    }
    return { db, ctx, events, sessionId: s.id, threadId: t.id }
  }

  it('add_comment inserts an agent-authored comment carrying identity', async () => {
    const { db, ctx, sessionId, threadId } = setup()
    const host = createToolHost(ctx)
    const { isError, action } = await host.call('add_comment', {
      anchor: { kind: 'diff', file: 'src/a.ts', side: 'new', line: 2 }, text: 'Consider a guard here'
    })
    expect(isError).toBeFalsy()
    const added = loadReviewState(db, sessionId).comments.find((c) => c.author === 'agent')!
    expect(added.text).toBe('Consider a guard here')
    expect(added.agentRef).toEqual({ engine: 'claude', model: 'opus' })
    expect(added.threadId).toBe(threadId)
    expect(added.anchor).toEqual({ kind: 'diff', file: 'src/a.ts', side: 'new', line: 2, hunkRange: '', lineContent: '' })
    expect(action).toMatchObject({ kind: 'comment_added' })
  })

  it('reply_to_comment appends an agent reply with identity', async () => {
    const { db, ctx, sessionId, threadId } = setup()
    const host = createToolHost(ctx)
    const { action } = await host.call('reply_to_comment', { commentId: 'u1', text: 'Fixed by adding the guard.' })
    const c = loadReviewState(db, sessionId).comments.find((x) => x.id === 'u1')!
    expect(c.replies.at(-1)).toMatchObject({ author: 'agent', text: 'Fixed by adding the guard.', threadId })
    expect(action).toMatchObject({ kind: 'comment_replied', commentId: 'u1' })
  })

  it('resolve_comment sets status + resolution', async () => {
    const { db, ctx, sessionId } = setup()
    const host = createToolHost(ctx)
    await host.call('resolve_comment', { commentId: 'u1', verdict: 'addressed', note: 'done' })
    const c = loadReviewState(db, sessionId).comments.find((x) => x.id === 'u1')!
    expect(c.status).toBe('resolved')
    expect(c.resolution).toEqual({ verdict: 'addressed', note: 'done', agentRef: { engine: 'claude', model: 'opus' } })
  })

  it('errors (no throw) on an unknown comment id', async () => {
    const { ctx } = setup()
    const host = createToolHost(ctx)
    const { isError } = await host.call('resolve_comment', { commentId: 'nope', verdict: 'addressed', note: 'x' })
    expect(isError).toBe(true)
  })

  it('list_comments returns the queued batch', async () => {
    const { ctx } = setup()
    const host = createToolHost(ctx)
    const { result } = await host.call('list_comments', { status: 'queued' })
    const items = JSON.parse(result) as { id: string; text: string }[]
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ id: 'u1', text: 'log this' })
  })
})

describe('review edit tools (real temp DB)', () => {
  const pair: RefPair = {
    base: { kind: 'branch', symbol: 'main', anchorSha: 'a'.repeat(40) },
    compare: { kind: 'branch', symbol: 'feature', anchorSha: 'b'.repeat(40) }
  }
  const annotations: ReviewAnnotations = {
    title: 'Old title', summary: 'Old summary',
    sections: [{ id: 's1', name: 'Auth', desc: 'old desc', what: 'old what', files: ['src/a.ts'], order: 1 }],
    questions: []
  }

  function setup(): { db: DatabaseSync; ctx: ToolHostCtx; sessionId: number } {
    const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'limn-rev-')), 'db')).db
    const s = createSession(db, '/repo', pair, { engine: 'claude' })
    const t = createChatThread(db, s.id, { kind: 'user', agent: { engine: 'claude' } })
    updateSessionMeta(db, s.id, { annotations, title: annotations.title, summary: annotations.summary })
    const ctx: ToolHostCtx = {
      db, sessionId: s.id, threadId: t.id, opId: 'o', repo: '/repo',
      agent: { engine: 'claude' }, emit: () => {}
    }
    return { db, ctx, sessionId: s.id }
  }

  it('get_review returns the current title + sections', async () => {
    const { ctx } = setup()
    const { result } = await createToolHost(ctx).call('get_review', {})
    const parsed = JSON.parse(result) as { title: string; sections: { what: string }[] }
    expect(parsed.title).toBe('Old title')
    expect(parsed.sections[0].what).toBe('old what')
  })

  it('edit_review patches the summary and syncs the denormalized column', async () => {
    const { db, ctx, sessionId } = setup()
    const { action } = await createToolHost(ctx).call('edit_review', { field: 'summary', value: 'New summary' })
    expect(loadReviewState(db, sessionId).annotations!.summary).toBe('New summary')
    const row = db.prepare('SELECT summary FROM sessions WHERE id = ?').get(sessionId) as { summary: string }
    expect(row.summary).toBe('New summary') // blob ↔ denormalized column in sync
    expect(action).toMatchObject({ kind: 'review_edited', field: 'summary' })
  })

  it('edit_review patches a section narration field', async () => {
    const { db, ctx, sessionId } = setup()
    await createToolHost(ctx).call('edit_review', { field: 'section.what', sectionId: 's1', value: 'now notes clock skew' })
    expect(loadReviewState(db, sessionId).annotations!.sections[0].what).toBe('now notes clock skew')
  })

  it('errors (no throw) editing a missing section', async () => {
    const { ctx } = setup()
    const { isError } = await createToolHost(ctx).call('edit_review', { field: 'section.desc', sectionId: 'nope', value: 'x' })
    expect(isError).toBe(true)
  })
})

// commit_changes was removed — the agent commits via git through its own shell,
// and resolutions are recorded with resolve_comment (covered above).
