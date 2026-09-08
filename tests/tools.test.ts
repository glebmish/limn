import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { assertAutoAcceptCoverage, AUTO_ACCEPT_TOOL_NAMES, createToolHost, LIMN_TOOLS, limnAllowedToolNames, SHARED_LANE_TOOL_NAMES, type ToolDef, type ToolHostCtx } from '../src/server/engines/tools'
import { FakeEngine } from '../src/server/engines/fake'
import { makeFixtureRepo } from './helpers/fixtureRepo'
import { openDb } from '../src/server/db/db'
import { createSession, createChatThread, upsertComment, loadReviewState, updateSessionMeta, replaceUiState } from '../src/server/db/sessions'
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

const ALL_TOOLS = ['add_comment', 'add_finding', 'edit_review', 'get_review', 'get_review_progress', 'list_comments', 'point', 'reply_to_comment', 'resolve_comment', 'suggest_mark_viewed', 'update_plan_status']
const mcp = (n: string): string => `mcp__limn__${n}`

describe('LIMN_TOOLS catalog', () => {
  it('exposes the point/suggest + comment/review tools (no write tool — commits go through git)', () => {
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

describe('AUTO_ACCEPT_TOOL_NAMES — auto-accept allowlist', () => {
  it('covers exactly the current LIMN_TOOLS (two-way set equality)', () => {
    // Every current tool is metadata-only, so all are cleared for auto-accept.
    // A new tool that isn't consciously listed here fails this test — a red test,
    // not a production throw. And no stale allowlist entry may linger either.
    expect([...AUTO_ACCEPT_TOOL_NAMES].sort()).toEqual(LIMN_TOOLS.map((t) => t.name).sort())
  })

  it('assertAutoAcceptCoverage passes for the current tool set', () => {
    expect(() => assertAutoAcceptCoverage(LIMN_TOOLS)).not.toThrow()
  })

  it('assertAutoAcceptCoverage throws the explanatory error for an unlisted tool', () => {
    const fake: ToolDef = { name: 'write_file', description: 'x', input: {} }
    expect(() => assertAutoAcceptCoverage([...LIMN_TOOLS, fake]))
      .toThrow(/limn tools not cleared for auto-accept: write_file/)
  })
})

describe('SHARED_LANE_TOOL_NAMES — what a read-only shared-lane turn may call', () => {
  it('withholds exactly the two annotation-rewriting tools, and lists only real tools', () => {
    // A generation on the exclusive lane persists the annotations snapshot it took
    // before the shared turn started, so a whole-blob rewrite from that turn is lost.
    // A new tool must be classified here (this fails until it is).
    const withheld = LIMN_TOOLS.map((t) => t.name).filter((n) => !SHARED_LANE_TOOL_NAMES.has(n)).sort()
    expect(withheld).toEqual(['edit_review', 'update_plan_status'])
    for (const n of SHARED_LANE_TOOL_NAMES) expect(LIMN_TOOLS.some((t) => t.name === n)).toBe(true)
  })
})

describe('createToolHost — point', () => {
  it('points at a single diff line (1 stop), emitting + collecting the action', async () => {
    const { ctx, events } = makeCtx()
    const host = createToolHost(ctx)
    const { result, isError, action } = await host.call('point', {
      stops: [{ target: { kind: 'diff', file: 'src/auth/jwt.ts', side: 'new', line: 31 } }]
    })
    expect(isError).toBeFalsy()
    expect(result).toContain('jwt.ts')
    expect(action).toEqual({
      kind: 'point',
      stops: [{ target: { kind: 'diff', file: 'src/auth/jwt.ts', side: 'new', line: 31, hunkRange: '', lineContent: '' } }]
    })
    expect(actionEvents(events)).toEqual([action])
    expect(host.collected()).toEqual([action])
  })

  // #18: a stop with no stamp and no quote can never be re-anchored, so it keeps
  // naming the line number it was created at long after that code moved. `point`
  // stamps its diff stops the same way `add_comment` stamps a comment anchor.
  it('stamps a diff stop against the current surface (quote + blob + context)', async () => {
    const fx2 = makeFixtureRepo()
    const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'limn-point-')), 'db')).db
    const s = createSession(db, fx2.dir, {
      base: { kind: 'branch', symbol: 'main', anchorSha: fx2.shas.base },
      compare: { kind: 'branch', symbol: 'feature', anchorSha: fx2.shas.head }
    }, { engine: 'claude' })
    const { ctx } = makeCtx({ db, sessionId: s.id, repo: fx2.dir })
    const host = createToolHost(ctx)
    const { action } = await host.call('point', {
      stops: [{ target: { kind: 'diff', file: 'src/a.ts', side: 'new', line: 2 } }]
    })
    const target = (action as Extract<AgentAction, { kind: 'point' }>).stops[0].target
    expect(target.kind === 'diff' && target.lineContent).toBe('  return 2') // healed: the re-anchor key
    expect(target.kind === 'diff' && target.stamp?.origLine).toBe(2)
    expect(target.kind === 'diff' && target.context?.before).toEqual(['export function a() {'])
  })

  it('leaves non-diff stops (and an unstampable repo) alone rather than failing the call', async () => {
    const { ctx } = makeCtx() // db: null, repo: /tmp/repo — stamping cannot run
    const host = createToolHost(ctx)
    const { isError, action } = await host.call('point', {
      stops: [{ target: { kind: 'summary' } }, { target: { kind: 'diff', file: 'a.ts', side: 'new', line: 3 } }]
    })
    expect(isError).toBeFalsy()
    expect(action).toEqual({
      kind: 'point',
      stops: [
        { target: { kind: 'summary' } },
        { target: { kind: 'diff', file: 'a.ts', side: 'new', line: 3, hunkRange: '', lineContent: '' } }
      ]
    })
  })

  it('preserves a diff stop\'s endLine range', async () => {
    const { ctx } = makeCtx()
    const host = createToolHost(ctx)
    const { action } = await host.call('point', {
      stops: [{ target: { kind: 'diff', file: 'a.ts', side: 'new', line: 3, endLine: 9 } }]
    })
    expect(action).toEqual({
      kind: 'point',
      stops: [{ target: { kind: 'diff', file: 'a.ts', side: 'new', line: 3, endLine: 9, hunkRange: '', lineContent: '' } }]
    })
  })

  it('points at the summary and a section (single-stop each)', async () => {
    const { ctx } = makeCtx()
    const host = createToolHost(ctx)
    const a = await host.call('point', { stops: [{ target: { kind: 'summary' } }] })
    const b = await host.call('point', { stops: [{ target: { kind: 'section', sectionId: 's2' } }] })
    expect(a.action).toEqual({ kind: 'point', stops: [{ target: { kind: 'summary' } }] })
    expect(b.action).toEqual({ kind: 'point', stops: [{ target: { kind: 'section', sectionId: 's2' } }] })
    expect(host.collected()).toEqual([a.action, b.action])
  })

  it('creates a multi-stop walkthrough, emitting + collecting the action', async () => {
    const { ctx, events } = makeCtx()
    const host = createToolHost(ctx)
    const { result, isError, action } = await host.call('point', {
      stops: [
        { target: { kind: 'diff', file: 'src/auth/jwt.ts', side: 'new', line: 31 }, note: '  new guard  ' },
        { target: { kind: 'section', sectionId: 's2' } }
      ],
      loop: true
    })
    const expected: AgentAction = {
      kind: 'point',
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

  it('accepts the max of 8 stops', async () => {
    const { ctx } = makeCtx()
    const host = createToolHost(ctx)
    const stops = Array.from({ length: 8 }, (_, i) => ({ target: { kind: 'section' as const, sectionId: `s${i}` } }))
    const { isError, action } = await host.call('point', { stops })
    expect(isError).toBeFalsy()
    expect(action?.kind === 'point' && action.stops).toHaveLength(8)
  })

  it('rejects 0 stops and 9 stops without emitting or collecting', async () => {
    const { ctx, events } = makeCtx()
    const host = createToolHost(ctx)
    const zeroStops = await host.call('point', { stops: [] })
    const nineStops = await host.call('point', {
      stops: Array.from({ length: 9 }, (_, i) => ({ target: { kind: 'section' as const, sectionId: `s${i}` } }))
    })
    expect(zeroStops.isError).toBe(true)
    expect(nineStops.isError).toBe(true)
    expect(events).toEqual([])
    expect(host.collected()).toEqual([])
  })

  it('rejects malformed stops without emitting or collecting', async () => {
    const { ctx, events } = makeCtx()
    const host = createToolHost(ctx)
    const badStop = await host.call('point', {
      stops: [
        { target: { kind: 'summary' } },
        { target: { kind: 'diff' } }
      ]
    })
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
  it('emits scripted point (single + multi-stop) + suggestion actions through the host', async () => {
    const { ctx, events } = makeCtx()
    const host = createToolHost(ctx)
    const engine = new FakeEngine()
    const run = engine.chat({ repo: '/tmp/repo', message: 'where is the JWT parsed?', tools: host })
    for await (const _ of run.events) { /* drain */ }
    await run.result
    const kinds = actionEvents(events).map((a) => a.kind)
    expect(kinds.filter((k) => k === 'point')).toHaveLength(2)
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

  it('add_finding mints a PROPOSED comment sourced to the run, with severity, on the new side', async () => {
    const { db, ctx, sessionId, threadId } = setup()
    const host = createToolHost({ ...ctx, run: { actionId: 'act-1', runId: 'run-1-1' } })
    const { isError, result, action } = await host.call('add_finding', {
      file: 'src/a.ts', line: 2, severity: 'risk', body: 'round() is skipped on this path'
    })
    expect(isError).toBeFalsy()
    expect(result).toContain('src/a.ts:2')
    const added = loadReviewState(db, sessionId).comments.find((c) => c.id.startsWith('af-'))!
    expect(added.status).toBe('proposed')
    expect(added.severity).toBe('risk')
    expect(added.author).toBe('agent')
    expect(added.agentRef).toEqual({ engine: 'claude', model: 'opus' })
    expect(added.threadId).toBe(threadId)
    expect(added.source).toEqual({ actionId: 'act-1', runId: 'run-1-1', threadId })
    expect(added.text).toBe('round() is skipped on this path')
    expect(added.anchor).toEqual({ kind: 'diff', file: 'src/a.ts', side: 'new', line: 2, hunkRange: '', lineContent: '' })
    expect(action).toMatchObject({ kind: 'finding_added', comment: { id: added.id } })
  })

  it('add_finding keeps a range and folds a suggestion into the body', async () => {
    const { db, ctx, sessionId } = setup()
    const host = createToolHost({ ...ctx, run: { actionId: 'act-1', runId: 'run-1-1' } })
    await host.call('add_finding', { file: 'src/a.ts', line: 2, endLine: 4, severity: 'note', body: 'dup', suggestion: 'gross()' })
    const added = loadReviewState(db, sessionId).comments.find((c) => c.id.startsWith('af-'))!
    expect(added.anchor).toMatchObject({ line: 2, endLine: 4 })
    expect(added.text).toBe('dup\n\nSuggestion:\n```\ngross()\n```')
  })

  it('add_finding refuses outside an action run — nothing to source the proposal to', async () => {
    const { db, ctx, sessionId } = setup()
    const host = createToolHost(ctx)
    const { isError, result } = await host.call('add_finding', { file: 'src/a.ts', line: 2, severity: 'note', body: 'x' })
    expect(isError).toBe(true)
    expect(result).toContain('action run')
    expect(loadReviewState(db, sessionId).comments.some((c) => c.id.startsWith('af-'))).toBe(false)
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
  const anchoredTarget = { kind: 'diff', file: 'src/a.ts', side: 'new', line: 3, hunkRange: '@@', lineContent: 'x' } as const
  function baseAnnotations(): ReviewAnnotations {
    return {
      title: 'Old title', summary: 'Old summary',
      sections: [{
        id: 's1', name: 'Auth', files: ['src/a.ts'],
        narration: [
          { text: 'framing block' },
          { text: 'anchored block', anchor: anchoredTarget }
        ]
      }],
      planMap: {
        acceptance: [{ text: 'Handles auth', met: 'partial' }],
        steps: [],
        deviations: []
      },
      questions: []
    }
  }

  function setup(annotations: ReviewAnnotations = baseAnnotations()): { db: DatabaseSync; ctx: ToolHostCtx; sessionId: number } {
    const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'limn-rev-')), 'db')).db
    const s = createSession(db, '/repo', pair, { engine: 'claude' })
    const t = createChatThread(db, s.id, { kind: 'user', agent: { engine: 'claude' } })
    updateSessionMeta(db, s.id, { annotations })
    const ctx: ToolHostCtx = {
      db, sessionId: s.id, threadId: t.id, opId: 'o', repo: '/repo',
      agent: { engine: 'claude' }, emit: () => {}
    }
    return { db, ctx, sessionId: s.id }
  }

  it('get_review returns the current title + indexed narration + contrast presence', async () => {
    const { ctx } = setup()
    const { result } = await createToolHost(ctx).call('get_review', {})
    const parsed = JSON.parse(result) as {
      title: string
      sections: { narration: string[]; contrast?: unknown }[]
    }
    expect(parsed.title).toBe('Old title')
    // array position == blockIndex, so block addressing lines up
    expect(parsed.sections[0].narration).toEqual(['framing block', 'anchored block'])
    expect(parsed.sections[0].contrast).toBeUndefined()
  })

  it('get_review surfaces contrast when set', async () => {
    const ann = baseAnnotations()
    ann.sections[0].contrast = { was: 'threw', now: 'returns null' }
    const { ctx } = setup(ann)
    const { result } = await createToolHost(ctx).call('get_review', {})
    const parsed = JSON.parse(result) as { sections: { contrast?: { was: string; now: string } }[] }
    expect(parsed.sections[0].contrast).toEqual({ was: 'threw', now: 'returns null' })
  })

  it('edit_review patches the summary and syncs the denormalized column', async () => {
    const { db, ctx, sessionId } = setup()
    const { action } = await createToolHost(ctx).call('edit_review', { field: 'summary', value: 'New summary' })
    expect(loadReviewState(db, sessionId).annotations!.summary).toBe('New summary')
    const row = db.prepare('SELECT summary FROM sessions WHERE id = ?').get(sessionId) as { summary: string }
    expect(row.summary).toBe('New summary') // blob ↔ denormalized column in sync
    expect(action).toMatchObject({ kind: 'review_edited', field: 'summary' })
  })

  it('edit_review patches the title', async () => {
    const { db, ctx, sessionId } = setup()
    const { action } = await createToolHost(ctx).call('edit_review', { field: 'title', value: 'New title' })
    expect(loadReviewState(db, sessionId).annotations!.title).toBe('New title')
    expect(action).toMatchObject({ kind: 'review_edited', field: 'title' })
  })

  it('edit_review section.block replace overwrites text and preserves an existing anchor', async () => {
    const { db, ctx, sessionId } = setup()
    const { action } = await createToolHost(ctx).call('edit_review', {
      field: 'section.block', sectionId: 's1', blockIndex: 1, op: 'replace', value: 'rewritten anchored block'
    })
    const sec = loadReviewState(db, sessionId).annotations!.sections[0]
    expect(sec.narration[1]).toEqual({ text: 'rewritten anchored block', anchor: anchoredTarget })
    expect(sec.narration).toHaveLength(2)
    expect(action).toMatchObject({ kind: 'review_edited', field: 'section.block', sectionId: 's1' })
  })

  it('edit_review section.block replace on an unanchored block stays unanchored', async () => {
    const { db, ctx, sessionId } = setup()
    await createToolHost(ctx).call('edit_review', {
      field: 'section.block', sectionId: 's1', blockIndex: 0, op: 'replace', value: 'rewritten framing'
    })
    const sec = loadReviewState(db, sessionId).annotations!.sections[0]
    expect(sec.narration[0]).toEqual({ text: 'rewritten framing' })
  })

  it('edit_review section.block insert splices a new block at the index', async () => {
    const { db, ctx, sessionId } = setup()
    await createToolHost(ctx).call('edit_review', {
      field: 'section.block', sectionId: 's1', blockIndex: 1, op: 'insert', value: 'inserted block'
    })
    const sec = loadReviewState(db, sessionId).annotations!.sections[0]
    expect(sec.narration.map((b) => b.text)).toEqual(['framing block', 'inserted block', 'anchored block'])
    expect(sec.narration[2].anchor).toEqual(anchoredTarget) // shifted, not mutated
  })

  it('edit_review section.block delete removes the block at the index (no value needed)', async () => {
    const { db, ctx, sessionId } = setup()
    const { isError } = await createToolHost(ctx).call('edit_review', {
      field: 'section.block', sectionId: 's1', blockIndex: 0, op: 'delete'
    })
    expect(isError).toBeFalsy()
    const sec = loadReviewState(db, sessionId).annotations!.sections[0]
    expect(sec.narration).toEqual([{ text: 'anchored block', anchor: anchoredTarget }])
  })

  it('edit_review section.block replace throws when value is omitted', async () => {
    const { ctx } = setup()
    const { isError, result } = await createToolHost(ctx).call('edit_review', {
      field: 'section.block', sectionId: 's1', blockIndex: 0, op: 'replace'
    })
    expect(isError).toBe(true)
    expect(result).toMatch(/requires a value/)
  })

  it('edit_review section.block throws on an out-of-range blockIndex', async () => {
    const { ctx } = setup()
    const { isError, result } = await createToolHost(ctx).call('edit_review', {
      field: 'section.block', sectionId: 's1', blockIndex: 5, op: 'replace', value: 'x'
    })
    expect(isError).toBe(true)
    expect(result).toMatch(/blockIndex/)
  })

  it('edit_review section.block throws on an unknown sectionId', async () => {
    const { ctx } = setup()
    const { isError, result } = await createToolHost(ctx).call('edit_review', {
      field: 'section.block', sectionId: 'nope', blockIndex: 0, op: 'replace', value: 'x'
    })
    expect(isError).toBe(true)
    expect(result).toMatch(/No section with id nope/)
  })

  it('edit_review section.contrast sets was/now', async () => {
    const { db, ctx, sessionId } = setup()
    const { action } = await createToolHost(ctx).call('edit_review', {
      field: 'section.contrast', sectionId: 's1', was: 'threw on missing token', now: 'returns null'
    })
    const sec = loadReviewState(db, sessionId).annotations!.sections[0]
    expect(sec.contrast).toEqual({ was: 'threw on missing token', now: 'returns null' })
    expect(action).toMatchObject({ kind: 'review_edited', field: 'section.contrast', sectionId: 's1' })
  })

  it('edit_review rejects the retired section.verify field as invalid input', async () => {
    const { db, ctx, sessionId } = setup()
    const { isError, action } = await createToolHost(ctx).call('edit_review', {
      field: 'section.verify', sectionId: 's1', value: 'npm test'
    })
    expect(isError).toBe(true)
    expect(action).toBeUndefined()
    const sec = loadReviewState(db, sessionId).annotations!.sections[0] as unknown as Record<string, unknown>
    expect('verify' in sec).toBe(false)
  })

  it('update_plan_status flips acceptance[index].met (partial -> true) with a note, emits + persists', async () => {
    const { db, ctx, sessionId } = setup()
    const { isError, action } = await createToolHost(ctx).call('update_plan_status', {
      index: 0, met: true, note: 'confirmed by test run'
    })
    expect(isError).toBeFalsy()
    const planMap = loadReviewState(db, sessionId).annotations!.planMap!
    expect(planMap.acceptance[0].met).toBe(true)
    // the note the schema makes mandatory rides on the action, so the chip can
    // show the reviewer WHY a criterion flipped (it used to reach only the model)
    expect(action).toEqual({ kind: 'plan_status_updated', index: 0, met: true, note: 'confirmed by test run' })
  })

  it('update_plan_status throws on an out-of-range index', async () => {
    const { ctx } = setup()
    const { isError, result } = await createToolHost(ctx).call('update_plan_status', { index: 9, met: true, note: 'x' })
    expect(isError).toBe(true)
    expect(result).toMatch(/index/)
  })

  it('a host restricted to the shared lane refuses edit_review with an actionable error, changing nothing', async () => {
    const { db, ctx, sessionId } = setup()
    const events: EngineEvent[] = []
    const host = createToolHost({ ...ctx, allowedTools: SHARED_LANE_TOOL_NAMES, emit: (e) => events.push(e) })
    const { isError, result, action } = await host.call('edit_review', { field: 'summary', value: 'New summary' })
    expect(isError).toBe(true)
    // the reason names the lane, not a specific op: the shared lane is taken while
    // ANY exclusive op (a generation, a merge, another thread's turn) holds the repo
    expect(result).toMatch(/unavailable on this turn: another review operation holds this repo/)
    expect(action).toBeUndefined()
    expect(events).toEqual([])
    expect(host.collected()).toEqual([])
    expect(loadReviewState(db, sessionId).annotations!.summary).toBe('Old summary')
  })

  it('a host restricted to the shared lane refuses update_plan_status, leaving the criterion alone', async () => {
    const { db, ctx, sessionId } = setup()
    const host = createToolHost({ ...ctx, allowedTools: SHARED_LANE_TOOL_NAMES })
    const { isError } = await host.call('update_plan_status', { index: 0, met: true, note: 'x' })
    expect(isError).toBe(true)
    expect(loadReviewState(db, sessionId).annotations!.planMap!.acceptance[0].met).toBe('partial')
  })

  it('a host restricted to the shared lane still serves the read/comment tools', async () => {
    const { ctx } = setup()
    const host = createToolHost({ ...ctx, allowedTools: SHARED_LANE_TOOL_NAMES })
    const { isError, result } = await host.call('get_review', {})
    expect(isError).toBeFalsy()
    expect(JSON.parse(result) as { title: string }).toMatchObject({ title: 'Old title' })
  })

  it('update_plan_status throws when there is no planMap', async () => {
    const ann = baseAnnotations()
    delete ann.planMap
    const { ctx } = setup(ann)
    const { isError, result } = await createToolHost(ctx).call('update_plan_status', { index: 0, met: true, note: 'x' })
    expect(isError).toBe(true)
    expect(result).toMatch(/planMap/)
  })
})

describe('get_review_progress (real temp DB)', () => {
  const pair: RefPair = {
    base: { kind: 'branch', symbol: 'main', anchorSha: 'a'.repeat(40) },
    compare: { kind: 'branch', symbol: 'feature', anchorSha: 'b'.repeat(40) }
  }
  function comment(id: string, status: Comment['status']): Comment {
    return {
      id, anchor: { kind: 'file', file: 'src/a.ts' }, author: 'user', text: `c-${id}`,
      status, replies: [], createdAt: 'now', iteration: 0
    }
  }

  function setup(): { db: DatabaseSync; ctx: ToolHostCtx; sessionId: number } {
    const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'limn-progress-')), 'db')).db
    const s = createSession(db, '/repo', pair, { engine: 'claude' })
    const t = createChatThread(db, s.id, { kind: 'user', agent: { engine: 'claude' } })
    replaceUiState(db, s.id, {
      viewedAt: { 'src/a.ts': { sha: 'c'.repeat(40), hash: 'hash1' } }
    })
    upsertComment(db, s.id, comment('c1', 'queued'))
    upsertComment(db, s.id, comment('c2', 'sent'))
    upsertComment(db, s.id, comment('c3', 'resolved'))
    upsertComment(db, s.id, comment('c4', 'outdated'))
    const ctx: ToolHostCtx = {
      db, sessionId: s.id, threadId: t.id, opId: 'o', repo: '/repo',
      agent: { engine: 'claude' }, emit: () => {}
    }
    return { db, ctx, sessionId: s.id }
  }

  it('reports viewed files and comment counts by status', async () => {
    const { ctx } = setup()
    const { result, isError } = await createToolHost(ctx).call('get_review_progress', {})
    expect(isError).toBeFalsy()
    const parsed = JSON.parse(result) as {
      viewed_files: { file: string; sha: string }[]
      comments: { queued: number; sent: number; resolved: number; outdated: number }
    }
    expect(parsed.viewed_files).toEqual([{ file: 'src/a.ts', sha: 'c'.repeat(40) }])
    expect(parsed.comments).toEqual({ queued: 1, sent: 1, resolved: 1, outdated: 1, proposed: 0, dismissed: 0 })
  })

  // Section progress is derived from per-file view marks in the UI and was never
  // written back, so the old `reviewed_sections` key told the agent "no sections
  // read" for every session — worse than saying nothing. It must stay gone.
  it('does not tell the agent about reviewed sections', async () => {
    const { ctx } = setup()
    const { result } = await createToolHost(ctx).call('get_review_progress', {})
    expect(Object.keys(JSON.parse(result) as object)).not.toContain('reviewed_sections')
  })

  // A view mark is only a live tick while the file still matches the sha (and
  // content) it was ticked at — the UI clears it on drift (fileViewed). The tool
  // can't compute that drift synchronously, so it must at least name the sha each
  // tick was taken at instead of implying every key is currently viewed.
  it('names the sha each view mark was taken at rather than emitting bare file keys', async () => {
    const { db, ctx, sessionId } = setup()
    replaceUiState(db, sessionId, {
      viewedAt: {
        'src/a.ts': { sha: 'c'.repeat(40), hash: 'hash1' },
        'src/b.ts': { sha: 'd'.repeat(40), hash: 'hash2' }
      }
    })
    const { result } = await createToolHost(ctx).call('get_review_progress', {})
    const parsed = JSON.parse(result) as { viewed_files: { file: string; sha: string }[] }
    expect(parsed.viewed_files).toEqual([
      { file: 'src/a.ts', sha: 'c'.repeat(40) },
      { file: 'src/b.ts', sha: 'd'.repeat(40) }
    ])
  })

  it('is read-only: emits no action and collects nothing', async () => {
    const { ctx } = setup()
    const events: EngineEvent[] = []
    const host = createToolHost({ ...ctx, emit: (e) => events.push(e) })
    const { action } = await host.call('get_review_progress', {})
    expect(action).toBeUndefined()
    expect(events).toEqual([])
    expect(host.collected()).toEqual([])
  })

  // Each view mark carries the sha it was taken at, but without the head those shas
  // are compared against, the agent has nothing to compare them TO — it cannot tell a
  // still-current tick from one the branch has moved past.
  it('names the compare head the view marks are measured against', async () => {
    const fx = makeFixtureRepo()
    const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'limn-progress-head-')), 'db')).db
    const s = createSession(db, fx.dir, {
      base: { kind: 'branch', symbol: 'main', anchorSha: fx.shas.base },
      compare: { kind: 'branch', symbol: 'feature', anchorSha: fx.shas.head }
    }, { engine: 'claude' })
    const t = createChatThread(db, s.id, { kind: 'user', agent: { engine: 'claude' } })
    replaceUiState(db, s.id, { viewedAt: { 'src/a.ts': { sha: fx.shas.firstFeature, hash: 'h' } } })
    const ctx: ToolHostCtx = {
      db, sessionId: s.id, threadId: t.id, opId: 'o', repo: fx.dir,
      agent: { engine: 'claude' }, emit: () => {}
    }
    const { result } = await createToolHost(ctx).call('get_review_progress', {})
    const parsed = JSON.parse(result) as { compare_head_sha: string | null; viewed_files: { sha: string }[] }
    expect(parsed.compare_head_sha).toBe(fx.shas.head)
    // …and it is a real answer to "changed since viewed": this tick predates the head
    expect(parsed.viewed_files[0].sha).not.toBe(parsed.compare_head_sha)
  })

  it('reports a null compare head rather than failing when the ref cannot be read', async () => {
    const { ctx } = setup() // repo '/repo' does not exist
    const { result, isError } = await createToolHost(ctx).call('get_review_progress', {})
    expect(isError).toBeFalsy()
    expect((JSON.parse(result) as { compare_head_sha: string | null }).compare_head_sha).toBeNull()
  })
})

// commit_changes was removed — the agent commits via git through its own shell,
// and resolutions are recorded with resolve_comment (covered above).
