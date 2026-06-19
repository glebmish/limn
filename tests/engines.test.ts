import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeFixtureRepo, type FixtureRepo } from './helpers/fixtureRepo'
import { getDiff, diffSince, markSince, headSha } from '../src/main/git'
import { mergeAnnotations } from '../src/main/engines/validate'
import { FakeEngine } from '../src/main/engines/fake'
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
        { id: 'a', name: 'A', desc: 'd', what: 'w', files: ['src/a.ts', 'src/NOPE.ts'], order: 1, flags: [] }
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
    const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lr-batch-')), 'db')).db
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
