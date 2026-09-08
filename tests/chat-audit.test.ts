import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createToolHost, LIMN_TOOLS, type ToolHostCtx } from '../src/server/engines/tools'
import { createSession, createChatThread, upsertComment, updateSessionMeta } from '../src/server/db/sessions'
import { openDb } from '../src/server/db/db'
import { ACTION_TOOL_KIND } from '../src/shared/toolcalls'
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
