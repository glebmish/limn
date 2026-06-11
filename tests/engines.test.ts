import { describe, it, expect, beforeAll } from 'vitest'
import { makeFixtureRepo, type FixtureRepo } from './helpers/fixtureRepo'
import { getDiff, diffSince, markSince, headSha } from '../src/main/git'
import { mergeAnnotations } from '../src/main/engines/validate'
import { FakeEngine } from '../src/main/engines/fake'
import type { Comment, EngineEvent } from '../src/shared/types'

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
  it('full cycle: review → comment → fix → since-tagging', async () => {
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

    // comment on a diff line of src/a.ts
    const comment: Comment = {
      id: 'c1',
      anchor: { kind: 'diff', file: 'src/a.ts', side: 'new', line: 2, hunkRange: '@@ -1,4 +1,5 @@', lineContent: '  return 2' },
      author: 'user', text: 'Please log this', status: 'queued', replies: [], createdAt: 'now', iteration: 1
    }
    const fixRun = engine.applyFeedback(fx.dir, sessionId, [comment])
    await drain(fixRun.events)
    const { value: fix } = await fixRun.result
    expect(fix.resolutions.map((r) => r.commentId)).toEqual(['c1'])

    // a new commit exists on the branch
    const newHead = await headSha(fx.dir, 'feature')
    expect(newHead).not.toBe(reviewedAt)

    // re-diff and tag since-approved
    const full2 = await getDiff(fx.dir, 'main', 'feature')
    const since = await diffSince(fx.dir, reviewedAt, 'feature')
    markSince(full2, since)
    const a2 = full2.files.find((f) => f.path === 'src/a.ts')!
    const sinceTexts = a2.hunks.flatMap((h) => h.lines.filter((l) => l.since).map((l) => l.text))
    expect(sinceTexts).toContain('// addressed by fake engine')
  })

  it('chat returns text', async () => {
    const engine = new FakeEngine()
    const run = engine.chat(fx.dir, 'sess', 'why?')
    const events = await drain(run.events)
    expect(events.some((e) => e.type === 'text')).toBe(true)
    const { value } = await run.result
    expect(value).toContain('why?')
  })
})
