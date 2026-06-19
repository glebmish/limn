import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { createToolHost, LR_TOOLS, lrAllowedToolNames, type ToolHostCtx } from '../src/main/engines/tools'
import { FakeEngine } from '../src/main/engines/fake'
import { openDb } from '../src/main/db/db'
import { createSession, createChatThread, upsertComment, loadReviewState, updateSessionMeta } from '../src/main/db/sessions'
import { makeFixtureRepo } from './helpers/fixtureRepo'
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
    writeEnabled: false,
    emit: (e) => events.push(e),
    ...over
  }
  return { ctx, events }
}

function actionEvents(events: EngineEvent[]): AgentAction[] {
  return events.filter((e): e is Extract<EngineEvent, { type: 'action' }> => e.type === 'action').map((e) => e.action)
}

const READ_TOOLS = ['add_comment', 'edit_review', 'focus', 'get_review', 'list_comments', 'reply_to_comment', 'resolve_comment', 'suggest_mark_viewed']
const ALL_TOOLS = [...READ_TOOLS, 'commit_changes'].sort()
const mcp = (n: string): string => `mcp__localreview__${n}`

describe('LR_TOOLS catalog', () => {
  it('exposes the focus/suggest + comment/review + commit tools', () => {
    expect(LR_TOOLS.map((t) => t.name).sort()).toEqual(ALL_TOOLS)
    for (const t of LR_TOOLS) {
      expect(t.description.length).toBeGreaterThan(0)
      expect(typeof t.input).toBe('object')
    }
  })

  it('withholds write tools (commit_changes) unless the turn is write-enabled', () => {
    expect(lrAllowedToolNames().sort()).toEqual(READ_TOOLS.map(mcp).sort()) // read-only default
    expect(lrAllowedToolNames(true).sort()).toEqual(ALL_TOOLS.map(mcp).sort()) // write-enabled adds commit_changes
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
    expect(action).toEqual({ kind: 'suggest_viewed', files: ['src/auth/jwt.ts'], note: 'looks fully understood' })
    expect(actionEvents(events)).toEqual([action])
    expect(host.collected()).toEqual([action])
  })

  it('supports sectionIds and requires at least one target', async () => {
    const { ctx } = makeCtx()
    const host = createToolHost(ctx)
    const ok = await host.call('suggest_mark_viewed', { sectionIds: ['s1'] })
    expect(ok.action).toEqual({ kind: 'suggest_viewed', sectionIds: ['s1'] })
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
    const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lr-tool-')), 'db')).db
    const s = createSession(db, '/repo', pair, { engine: 'claude' })
    const t = createChatThread(db, s.id, { kind: 'user', agent: { engine: 'claude', model: 'opus' } })
    upsertComment(db, s.id, userComment)
    const events: EngineEvent[] = []
    const ctx: ToolHostCtx = {
      db, sessionId: s.id, threadId: t.id, opId: 'o', repo: '/repo',
      agent: { engine: 'claude', model: 'opus' }, writeEnabled: false, emit: (e) => events.push(e)
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
    expect(c.resolution).toEqual({ verdict: 'addressed', note: 'done' })
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
    sections: [{ id: 's1', name: 'Auth', desc: 'old desc', what: 'old what', files: ['src/a.ts'], order: 1, flags: [] }],
    questions: []
  }

  function setup(): { db: DatabaseSync; ctx: ToolHostCtx; sessionId: number } {
    const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lr-rev-')), 'db')).db
    const s = createSession(db, '/repo', pair, { engine: 'claude' })
    const t = createChatThread(db, s.id, { kind: 'user', agent: { engine: 'claude' } })
    updateSessionMeta(db, s.id, { annotations, title: annotations.title, summary: annotations.summary })
    const ctx: ToolHostCtx = {
      db, sessionId: s.id, threadId: t.id, opId: 'o', repo: '/repo',
      agent: { engine: 'claude' }, writeEnabled: false, emit: () => {}
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

describe('commit_changes (real git repo)', () => {
  const branchPair: RefPair = {
    base: { kind: 'branch', symbol: 'main', anchorSha: 'a'.repeat(40) },
    compare: { kind: 'branch', symbol: 'feature', anchorSha: 'b'.repeat(40) }
  }

  function setup(writeEnabled: boolean): { db: DatabaseSync; ctx: ToolHostCtx; sessionId: number; dir: string } {
    const fx = makeFixtureRepo()
    const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lr-commit-')), 'db')).db
    const s = createSession(db, fx.dir, branchPair, { engine: 'claude' })
    const t = createChatThread(db, s.id, { kind: 'user', agent: { engine: 'claude' } })
    upsertComment(db, s.id, {
      id: 'q1', anchor: { kind: 'file', file: 'src/a.ts' }, author: 'user', text: 'tweak it',
      status: 'sent', replies: [], createdAt: 'now', iteration: 0
    })
    const ctx: ToolHostCtx = {
      db, sessionId: s.id, threadId: t.id, opId: 'o', repo: fx.dir,
      agent: { engine: 'claude' }, writeEnabled, engineSessionId: 'eng-1', emit: () => {}
    }
    return { db, ctx, sessionId: s.id, dir: fx.dir }
  }

  it('commits staged edits, records an iteration, resolves with the commit ref', async () => {
    const { db, ctx, sessionId, dir } = setup(true)
    fs.writeFileSync(path.join(dir, 'NEW.md'), 'hello\n')
    const { isError, action } = await createToolHost(ctx).call('commit_changes', {
      message: 'local-review: batch fix', resolutions: [{ commentId: 'q1', verdict: 'addressed', note: 'done' }]
    })
    expect(isError).toBeFalsy()
    const st = loadReviewState(db, sessionId)
    expect(st.iterations.at(-1)).toMatchObject({ summary: 'local-review: batch fix', engine: 'claude', sessionId: 'eng-1' })
    const c = st.comments.find((x) => x.id === 'q1')!
    expect(c.status).toBe('resolved')
    expect(c.resolution).toMatchObject({ verdict: 'addressed', note: 'done' })
    expect(c.resolution!.commit).toHaveLength(7)
    expect(action).toMatchObject({ kind: 'code_committed', message: 'local-review: batch fix' })
    expect((action as Extract<AgentAction, { kind: 'code_committed' }>).files).toContain('NEW.md')
  })

  it('refuses to commit when the turn is not write-enabled', async () => {
    const { ctx } = setup(false)
    const { isError } = await createToolHost(ctx).call('commit_changes', { message: 'nope' })
    expect(isError).toBe(true)
  })

  it('records resolutions but emits no commit chip when nothing is staged', async () => {
    const { db, ctx, sessionId } = setup(true) // fixture repo is clean → nothing to commit
    const { isError, action } = await createToolHost(ctx).call('commit_changes', {
      message: 'no-op', resolutions: [{ commentId: 'q1', verdict: 'skipped', note: 'not needed' }]
    })
    expect(isError).toBeFalsy()
    expect(action).toBeUndefined() // no code_committed chip — no commit actually happened
    const c = loadReviewState(db, sessionId).comments.find((x) => x.id === 'q1')!
    expect(c.status).toBe('resolved')
    expect(c.resolution!.commit).toBeUndefined() // no commit ref to backfill
  })
})
