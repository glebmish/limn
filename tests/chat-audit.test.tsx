import { afterEach, describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { createToolHost, LIMN_TOOLS, type ToolHostCtx } from '../src/server/engines/tools'
import { createSession, createChatThread, upsertComment, updateSessionMeta } from '../src/server/db/sessions'
import { openDb } from '../src/server/db/db'
import { ACTION_TOOL_KIND } from '../src/shared/toolcalls'
import { GenPanel } from '../src/renderer/components/GenPanel'
import { useStore } from '../src/renderer/store'
import type { OpState } from '../src/renderer/store'
import type { LoadedReview } from '../src/shared/ipc'
import type { AgentAction, Comment, RefPair, ReviewAnnotations } from '../src/shared/types'

// Finding 107: ACTION_TOOL_KIND (src/shared/toolcalls.ts) hand-mirrors the tool→
// action-kind pairing that src/server/engines/tools.ts states authoritatively.
// This suite is the test-time tie: it drives every LIMN_TOOLS entry through the
// real createToolHost and asserts the emitted action's `kind` (or its absence)
// against ACTION_TOOL_KIND — a renamed tool, a changed kind, or a new
// action-producing tool the renderer's table wasn't told about all fail here.
describe('ACTION_TOOL_KIND ties to what the server tools actually emit (#107)', () => {
  const pair: RefPair = {
    base: { kind: 'branch', symbol: 'main', anchorSha: 'a'.repeat(40) },
    compare: { kind: 'branch', symbol: 'feature', anchorSha: 'b'.repeat(40) }
  }
  const userComment: Comment = {
    id: 'u1',
    anchor: { kind: 'diff', file: 'src/a.ts', side: 'new', line: 2, hunkRange: '@@', lineContent: '  return 2' },
    author: 'user', text: 'log this', status: 'queued', replies: [], createdAt: 'now', iteration: 0
  }
  function baseAnnotations(): ReviewAnnotations {
    return {
      title: 'Old title', summary: 'Old summary',
      sections: [{ id: 's1', name: 'Auth', files: ['src/a.ts'], narration: [{ text: 'framing block' }] }],
      planMap: { acceptance: [{ text: 'Handles auth', met: 'partial' }], steps: [], deviations: [] },
      questions: []
    }
  }

  function setup(): { ctx: ToolHostCtx } {
    const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'limn-chat-audit-')), 'db')).db
    const s = createSession(db, '/repo', pair, { engine: 'claude' })
    const t = createChatThread(db, s.id, { kind: 'user', agent: { engine: 'claude' } })
    updateSessionMeta(db, s.id, { annotations: baseAnnotations() })
    upsertComment(db, s.id, userComment)
    const ctx: ToolHostCtx = {
      db, sessionId: s.id, threadId: t.id, opId: 'o', repo: '/repo',
      agent: { engine: 'claude' }, emit: () => {}
    }
    return { ctx }
  }

  // Minimal valid args per tool, exercising the real run() path (not a stub).
  const ACTION_CALLS: Record<string, unknown> = {
    point: { stops: [{ target: { kind: 'file', file: 'src/a.ts' } }] },
    suggest_mark_viewed: { files: ['src/a.ts'], note: 'covered it' },
    add_comment: { anchor: { kind: 'file', file: 'src/a.ts' }, text: 'note' },
    reply_to_comment: { commentId: 'u1', text: 'reply' },
    resolve_comment: { commentId: 'u1', verdict: 'addressed', note: 'done' },
    edit_review: { field: 'summary', value: 'New summary' },
    update_plan_status: { index: 0, met: true, note: 'verified' }
  }
  const READ_ONLY_CALLS: Record<string, unknown> = {
    list_comments: {}, get_review: {}, get_review_progress: {}
  }

  it('LIMN_TOOLS is exactly the action-producing tools plus the read-only ones (nothing unclassified)', () => {
    expect(LIMN_TOOLS.map((t) => t.name).sort()).toEqual(
      [...Object.keys(ACTION_CALLS), ...Object.keys(READ_ONLY_CALLS)].sort()
    )
  })

  it("ACTION_TOOL_KIND's keys are exactly the action-producing tools", () => {
    expect(Object.keys(ACTION_TOOL_KIND).sort()).toEqual(Object.keys(ACTION_CALLS).sort())
  })

  for (const [name, args] of Object.entries(ACTION_CALLS)) {
    it(`${name} emits an action whose kind matches ACTION_TOOL_KIND['${name}']`, async () => {
      const { ctx } = setup()
      const { action, isError, result } = await createToolHost(ctx).call(name, args)
      expect(isError, result).toBeFalsy()
      expect(action?.kind).toBe(ACTION_TOOL_KIND[name as keyof typeof ACTION_TOOL_KIND])
    })
  }

  for (const [name, args] of Object.entries(READ_ONLY_CALLS)) {
    it(`${name} emits no action`, async () => {
      const { ctx } = setup()
      const { action, isError, result } = await createToolHost(ctx).call(name, args)
      expect(isError, result).toBeFalsy()
      expect(action as AgentAction | undefined).toBeUndefined()
    })
  }
})

// Finding 108: GenPanel's primary generate CTAs disable on `gate.blocked || busy`
// (busy = anyExclusiveRunning) so a concurrent op (e.g. a chat batch) visibly blocks
// starting a new generation — except the cancelled-state "Retry generation" button,
// which only checked `gate.blocked`, so it looked clickable while busy and silently
// swallowed the click (startGenerateNow guards internally on anyExclusiveRunning).
describe('GenPanel primary CTAs disable while another exclusive op runs (#108)', () => {
  const op = (over: Partial<OpState>): OpState => ({
    running: true, opId: 'op', kind: 'chat', threadId: 1, log: [], error: null,
    startedAt: 0, outcome: null, errorCode: null, answeredApprovals: new Set(), exclusive: true, ...over
  })

  // GenPanel reads the store via bare `useStore()` (no selector). Under
  // renderToStaticMarkup, React's useSyncExternalStore takes zustand's
  // *server* snapshot (`getInitialState()`), not a `setState`-mutated one — so the
  // fixture must mutate the initial-state object in place, the same pattern
  // tests/dashboard-forget-repo.test.tsx uses for the same reason.
  type StoreState = ReturnType<typeof useStore.getState>
  const initial = (): StoreState => (useStore as unknown as { getInitialState: () => StoreState }).getInitialState()

  afterEach(() => {
    initial().ops = {}
    initial().loaded = null
  })

  /** The generation thread belongs to this review (threadId 3 is in state.chats), the
   *  generation for THIS review is cancelled and idle — reachable with `busy` true
   *  because busy is global: a follow-up chat turn in the drawer (a different thread,
   *  same repo) takes the exclusive lane while this review's own gen op sits cancelled. */
  function setupCancelled(busy: boolean): void {
    const gen: OpState = op({ opId: 'gen', kind: 'review', threadId: 3, running: false, outcome: 'cancelled' })
    const ops: Record<string, OpState> = busy
      ? { gen, other: op({ opId: 'other', kind: 'chat', threadId: 99, running: true, exclusive: true }) }
      : { gen }
    const loaded = { state: { chats: [{ id: 3 }], annotations: undefined } } as unknown as LoadedReview
    initial().ops = ops
    initial().loaded = loaded
  }

  /** Extract the opening tag of the <button> whose text is (or starts with) `text`,
   *  so we can inspect its `disabled` attribute without depending on markup order. */
  function buttonTag(html: string, text: string): string {
    const at = html.indexOf(text)
    if (at < 0) throw new Error(`button text not found: ${text}`)
    const start = html.lastIndexOf('<button', at)
    const end = html.indexOf('>', start)
    return html.slice(start, end)
  }

  it('the cancelled-state Retry generation button disables while another exclusive op runs', () => {
    setupCancelled(true)

    const html = renderToStaticMarkup(<GenPanel />)

    expect(buttonTag(html, 'Retry generation')).toContain('disabled')
  })

  it('the cancelled-state Retry generation button is enabled when nothing else is running', () => {
    setupCancelled(false)

    const html = renderToStaticMarkup(<GenPanel />)

    expect(buttonTag(html, 'Retry generation')).not.toContain('disabled')
  })

  it('the error-state Retry button also disables while busy (same omission)', () => {
    const gen: OpState = op({ opId: 'gen', kind: 'review', threadId: 3, running: false, outcome: 'failed', error: 'boom' })
    const ops: Record<string, OpState> = { gen, other: op({ opId: 'other', kind: 'chat', threadId: 99, running: true, exclusive: true }) }
    const loaded = { state: { chats: [{ id: 3 }], annotations: undefined } } as unknown as LoadedReview
    initial().ops = ops
    initial().loaded = loaded

    const html = renderToStaticMarkup(<GenPanel />)

    expect(buttonTag(html, 'Retry')).toContain('disabled')
  })
})
