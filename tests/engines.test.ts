import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { makeFixtureRepo, type FixtureRepo } from './helpers/fixtureRepo'
import { getDiff, diffSince, markSince, headSha } from '../src/main/git'
import { mergeAnnotations } from '../src/main/engines/validate'
import { FakeEngine } from '../src/main/engines/fake'
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
        { id: 'a', name: 'A', narration: [{ text: 'w' }], files: ['src/a.ts', 'src/NOPE.ts'] }
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

  it('sections may reference untracked files; unsectioned untracked stays orphan (not Other changes)', async () => {
    const sk = await getDiff(fx.dir, 'main', 'feature')
    const untracked = new Set(['new.ts', 'scratch.ts'])
    const raw = {
      title: 't', summary: 's',
      sections: [
        { id: 'a', name: 'A', narration: [{ text: 'w' }], files: [...sk.files.map((f) => f.path), 'new.ts'] }
      ],
      questions: []
    }
    const { annotations } = mergeAnnotations(sk, raw, untracked)
    const all = annotations.sections.flatMap((s) => s.files)
    expect(all).toContain('new.ts')          // a relevant untracked file the agent sectioned
    expect(all).not.toContain('scratch.ts')  // orphan untracked is NOT forced into the review
    // every tracked file was assigned, so there is no Other-changes catch-all here
    expect(annotations.sections.find((s) => s.id === 'other-changes')).toBeFalsy()
  })

  it('de-anchors a narration block that anchors an unknown file, keeping its text and warning', async () => {
    const sk = await getDiff(fx.dir, 'main', 'feature')
    const raw = {
      title: 't', summary: 's',
      sections: [
        {
          id: 'a', name: 'A', files: ['src/a.ts'],
          narration: [
            { text: 'keep me', anchor: { kind: 'file', file: 'src/NOPE.ts' } },
            { text: 'unanchored framing block' }
          ]
        }
      ],
      questions: []
    } as const
    const { annotations, warnings } = mergeAnnotations(sk, raw as any)
    expect(warnings.some((w) => w.includes('NOPE'))).toBe(true)
    const sec = annotations.sections.find((s) => s.id === 'a')!
    expect(sec.narration[0].text).toBe('keep me') // text survives
    expect(sec.narration[0].anchor).toBeUndefined() // anchor stripped
    expect(sec.narration[1].anchor).toBeUndefined() // untouched framing block
  })

  it('keeps a narration block anchored to a sectioned untracked file (untracked is valid diff content)', async () => {
    const sk = await getDiff(fx.dir, 'main', 'feature')
    const untracked = new Set(['new.ts'])
    const raw = {
      title: 't', summary: 's',
      sections: [
        {
          id: 'a', name: 'A', files: ['src/a.ts', 'new.ts'],
          narration: [{ text: 'the new untracked file', anchor: { kind: 'file', file: 'new.ts' } }]
        }
      ],
      questions: []
    } as const
    const { annotations, warnings } = mergeAnnotations(sk, raw as any, untracked)
    expect(warnings.some((w) => w.includes('new.ts'))).toBe(false) // not wrongly flagged
    const sec = annotations.sections.find((s) => s.id === 'a')!
    expect(sec.narration[0].anchor).toEqual({ kind: 'file', file: 'new.ts' }) // anchor kept
  })

  it('keeps a narration block anchored to a file owned by a different section (cross-reference)', async () => {
    const sk = await getDiff(fx.dir, 'main', 'feature')
    const raw = {
      title: 't', summary: 's',
      sections: [
        {
          id: 'a', name: 'A', files: ['src/a.ts'],
          narration: [{ text: 'see the added file below', anchor: { kind: 'file', file: 'src/b.ts' } }]
        },
        {
          id: 'b', name: 'B', files: ['src/b.ts'],
          narration: [{ text: 'the new file' }]
        }
      ],
      questions: []
    } as const
    const { annotations, warnings } = mergeAnnotations(sk, raw as any)
    expect(warnings.some((w) => w.includes('src/b.ts'))).toBe(false)
    const sec = annotations.sections.find((s) => s.id === 'a')!
    expect(sec.narration[0].anchor).toEqual({ kind: 'file', file: 'src/b.ts' }) // cross-reference kept
  })

  it('drops a diagram edge referencing an unknown node id, keeping the rest, with a warning', async () => {
    const sk = await getDiff(fx.dir, 'main', 'feature')
    const raw = {
      title: 't', summary: 's',
      sections: [
        {
          id: 'a', name: 'A', files: ['src/a.ts'],
          narration: [{ text: 'w' }],
          diagram: {
            why: 'why', caption: 'cap',
            nodes: [{ id: 'n1', label: 'One', kind: 'plain' }, { id: 'n2', label: 'Two', kind: 'plain' }],
            edges: [{ from: 'n1', to: 'n2' }, { from: 'n1', to: 'ghost' }]
          }
        }
      ],
      questions: []
    } as const
    const { annotations, warnings } = mergeAnnotations(sk, raw as any)
    expect(warnings.some((w) => w.includes('ghost'))).toBe(true)
    const sec = annotations.sections.find((s) => s.id === 'a')!
    expect(sec.diagram!.edges).toEqual([{ from: 'n1', to: 'n2' }])
  })

  it('warns (but keeps) a cyclic diagram edge set', async () => {
    const sk = await getDiff(fx.dir, 'main', 'feature')
    const raw = {
      title: 't', summary: 's',
      sections: [
        {
          id: 'a', name: 'A', files: ['src/a.ts'],
          narration: [{ text: 'w' }],
          diagram: {
            why: 'why', caption: 'cap',
            nodes: [{ id: 'n1', label: 'One', kind: 'plain' }, { id: 'n2', label: 'Two', kind: 'plain' }],
            edges: [{ from: 'n1', to: 'n2' }, { from: 'n2', to: 'n1' }]
          }
        }
      ],
      questions: []
    } as const
    const { annotations, warnings } = mergeAnnotations(sk, raw as any)
    expect(warnings.some((w) => w.toLowerCase().includes('cycle'))).toBe(true)
    const sec = annotations.sections.find((s) => s.id === 'a')!
    // cyclic edges are kept (only warned about) — the renderer falls back to a list
    expect(sec.diagram!.edges).toEqual([{ from: 'n1', to: 'n2' }, { from: 'n2', to: 'n1' }])
  })

  it('nulls a planMap acceptance source pointing at neither a diff file nor a known artifact, with a warning', async () => {
    const sk = await getDiff(fx.dir, 'main', 'feature')
    const raw = {
      title: 't', summary: 's',
      sections: [{ id: 'a', name: 'A', files: ['src/a.ts'], narration: [{ text: 'w' }] }],
      planMap: {
        acceptance: [{ text: 'does the thing', met: true, source: { path: 'src/GHOST.ts', line: 3 } }],
        steps: [], deviations: []
      },
      questions: []
    } as const
    const { annotations, warnings } = mergeAnnotations(sk, raw as any)
    expect(warnings.some((w) => w.includes('GHOST'))).toBe(true)
    const crit = annotations.planMap!.acceptance[0]
    expect(crit.text).toBe('does the thing') // entry kept
    expect(crit.source).toBeUndefined() // source nulled
  })

  it('keeps a planMap acceptance source pointing at a changed diff file', async () => {
    const sk = await getDiff(fx.dir, 'main', 'feature')
    const raw = {
      title: 't', summary: 's',
      sections: [{ id: 'a', name: 'A', files: ['src/a.ts'], narration: [{ text: 'w' }] }],
      planMap: {
        acceptance: [{ text: 'does the thing', met: true, source: { path: 'src/a.ts', line: 2 } }],
        steps: [], deviations: []
      },
      questions: []
    } as const
    const { annotations, warnings } = mergeAnnotations(sk, raw as any)
    expect(warnings.some((w) => w.includes('src/a.ts'))).toBe(false)
    expect(annotations.planMap!.acceptance[0].source).toEqual({ path: 'src/a.ts', line: 2 })
  })

  it('keeps a planMap acceptance source pointing at a known artifact path (not a diff file)', async () => {
    const sk = await getDiff(fx.dir, 'main', 'feature')
    const raw = {
      title: 't', summary: 's',
      sections: [{ id: 'a', name: 'A', files: ['src/a.ts'], narration: [{ text: 'w' }] }],
      planMap: {
        acceptance: [{ text: 'matches the spec', met: true, source: { path: 'docs/spec.md', line: 5 } }],
        steps: [], deviations: []
      },
      questions: []
    } as const
    const artifactPaths = new Set(['docs/spec.md'])
    const { annotations, warnings } = mergeAnnotations(sk, raw as any, new Set(), artifactPaths)
    expect(warnings.some((w) => w.includes('docs/spec.md'))).toBe(false)
    expect(annotations.planMap!.acceptance[0].source).toEqual({ path: 'docs/spec.md', line: 5 })
  })
})

describe('FakeEngine contract', () => {
  it('preserves the requested engine identity', () => {
    expect(new FakeEngine('codex').id).toBe('codex')
    expect(new FakeEngine('claude').id).toBe('claude')
  })

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
      agent: { engine: 'claude' }, engineSessionId: 'e1', emit: () => {}
    })
    const batch = engine.chat({ repo: fx.dir, message: 'handle the comments', tools: host, writeEnabled: true })
    await drain(batch.events)
    await batch.result

    // the agent resolved the comment via resolve_comment + committed via git
    const st = loadReviewState(db, s.id)
    expect(st.comments.find((c) => c.id === 'c1')!.status).toBe('resolved')

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

describe('FakeEngine generateScopedUpdate', () => {
  const prior = {
    title: 'Prior title',
    summary: 'Prior summary',
    sections: [
      { id: 's1', name: 'src', narration: [{ text: 'w' }], files: ['src/a.ts', 'src/b.ts'] },
      { id: 's2', name: 'docs', narration: [{ text: 'w' }], files: ['docs/x.md'] },
      { id: 's3', name: 'tests', narration: [{ text: 'w' }], files: ['tests/t.ts'] }
    ],
    questions: [{ id: 'q1', text: 'keep default?' }]
  }
  const fileDiff = (path: string, status: 'modified' | 'added' = 'modified') =>
    ({ path, status, binary: false, add: 1, del: 0, hunks: [] })

  it('revises the owner section by dir, mints a new section for an unowned dir, keeps the rest', async () => {
    const req = {
      repo: '/r', branch: 'feature', base: 'main', sinceSha: 'abc1234',
      since: [fileDiff('src/c.ts', 'added'), fileDiff('lib/new.ts', 'added')],
      prior
    }
    const run = new FakeEngine().generateScopedUpdate(req)
    const events = await drain(run.events)
    expect(events.some((e) => e.type === 'status')).toBe(true)
    const { value, sessionId } = await run.result
    expect(sessionId).toBeTruthy()

    // s1 owns dir 'src' → revised (same id), the new file unioned onto its files
    const revS1 = value.revisedSections.find((s) => s.id === 's1')!
    expect(revS1).toBeTruthy()
    expect(revS1.files).toEqual(expect.arrayContaining(['src/a.ts', 'src/b.ts', 'src/c.ts']))
    // 'lib' is unowned → a minted s4 (N+1 of the 3 prior sections)
    const minted = value.revisedSections.find((s) => !['s1', 's2', 's3'].includes(s.id))!
    expect(minted).toBeTruthy()
    expect(minted.id).toBe('s4')
    expect(minted.files).toEqual(['lib/new.ts'])
    // every untouched prior section is kept by id; nothing deleted; scalars keep prior
    expect(value.keptSectionIds.sort()).toEqual(['s2', 's3'])
    expect(value.deletedSectionIds).toEqual([])
    expect(value.resolvedQuestionIds).toEqual([])
    expect(value.newQuestions).toEqual([])
    expect(value.title).toBeNull()
    expect(value.summary).toBeNull()
    expect(value.planMap).toBeNull()
  })

  it('resumes the prior engine session id when present', async () => {
    const run = new FakeEngine().generateScopedUpdate({
      repo: '/r', branch: 'feature', base: 'main', sinceSha: 'abc1234',
      since: [fileDiff('src/a.ts')], prior, priorEngineSessionId: 'sess-prior'
    })
    await drain(run.events)
    const { value, sessionId } = await run.result
    expect(sessionId).toBe('sess-prior')
    // only s1 revised (owns 'src'); s2/s3 kept
    expect(value.revisedSections.map((s) => s.id)).toEqual(['s1'])
    expect(value.keptSectionIds.sort()).toEqual(['s2', 's3'])
  })

  it('[scoped-garbage] hook emits a handshake-violating patch', async () => {
    const run = new FakeEngine().generateScopedUpdate({
      repo: '/r', branch: 'feature', base: 'main', sinceSha: 'abc1234',
      since: [fileDiff('src/a.ts')], prior, steer: '[scoped-garbage]'
    })
    await drain(run.events)
    const { value } = await run.result
    // references an id that never existed and omits every real prior id
    expect(value.keptSectionIds).toEqual(['ghost-section-never-existed'])
    expect(value.revisedSections).toEqual([])
  })

  it('[scoped-dup] hook emits a patch with a duplicate revised id', async () => {
    const run = new FakeEngine().generateScopedUpdate({
      repo: '/r', branch: 'feature', base: 'main', sinceSha: 'abc1234',
      since: [fileDiff('src/a.ts')], prior, steer: '[scoped-dup]'
    })
    await drain(run.events)
    const { value } = await run.result
    const ids = value.revisedSections.map((s) => s.id)
    expect(ids).toEqual(['s1', 's1'])
    expect(new Set(ids).size).toBe(1) // duplicate
  })

  it('[scoped-fulldoc] hook rejects like an adapter parse failure', async () => {
    const run = new FakeEngine().generateScopedUpdate({
      repo: '/r', branch: 'feature', base: 'main', sinceSha: 'abc1234',
      since: [fileDiff('src/a.ts')], prior, steer: '[scoped-fulldoc]'
    })
    const rejects = expect(run.result).rejects.toThrow(/parse failed/)
    await drain(run.events)
    await rejects
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
