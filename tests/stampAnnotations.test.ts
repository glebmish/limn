import { describe, expect, it, beforeAll, vi } from 'vitest'
import { makeFixtureRepo, type FixtureRepo } from './helpers/fixtureRepo'
import * as git from '../src/server/git'
import { stampAnnotationAnchors } from '../src/server/engines/stampAnnotations'
import type { FocusTarget, ReviewAnnotations, SessionMeta } from '../src/shared/types'

type DiffAnchor = Extract<FocusTarget, { kind: 'diff' }>

let fx: FixtureRepo
beforeAll(() => {
  fx = makeFixtureRepo()
})

function fakeSession(): SessionMeta {
  return {
    id: 1,
    repo: fx.dir,
    pair: {
      base: { kind: 'branch', symbol: 'main', anchorSha: fx.shas.base },
      compare: { kind: 'branch', symbol: 'feature', anchorSha: fx.shas.head }
    },
    createdAt: 'now', updatedAt: 'now'
  }
}

describe('stampAnnotationAnchors', () => {
  it('stamps a diff-anchored narration block in place, leaves non-diff anchors and unanchored blocks untouched', async () => {
    const ann: ReviewAnnotations = {
      title: 't', summary: 's',
      sections: [
        {
          id: 'a', name: 'A', files: ['src/a.ts'],
          narration: [
            { text: 'anchored', anchor: { kind: 'diff', file: 'src/a.ts', side: 'new', line: 2, hunkRange: '', lineContent: '' } },
            { text: 'framing block' },
            { text: 'whole-file ref', anchor: { kind: 'file', file: 'src/a.ts' } }
          ]
        }
      ],
      questions: []
    }

    await stampAnnotationAnchors(fx.dir, fakeSession(), ann)

    const [diffBlock, framingBlock, fileBlock] = ann.sections[0].narration
    expect(diffBlock.anchor).toMatchObject({ kind: 'diff' })
    expect((diffBlock.anchor as DiffAnchor).stamp).toBeTruthy()
    expect((diffBlock.anchor as DiffAnchor).stamp!.headSha).toBe(fx.shas.head)
    expect(framingBlock.anchor).toBeUndefined()
    expect(fileBlock.anchor).toEqual({ kind: 'file', file: 'src/a.ts' }) // non-diff anchor untouched
  })

  it('stamps a diff-anchored diagram node in place, leaves non-diff node anchors untouched', async () => {
    const ann: ReviewAnnotations = {
      title: 't', summary: 's',
      sections: [
        {
          id: 'a', name: 'A', files: ['src/a.ts'],
          narration: [{ text: 'w' }],
          diagram: {
            why: 'why', caption: 'cap',
            nodes: [
              { id: 'n1', label: 'One', kind: 'plain', anchor: { kind: 'diff', file: 'src/a.ts', side: 'new', line: 2, hunkRange: '', lineContent: '' } },
              { id: 'n2', label: 'Two', kind: 'plain', anchor: { kind: 'file', file: 'src/a.ts' } },
              { id: 'n3', label: 'Three', kind: 'plain' }
            ],
            edges: [{ from: 'n1', to: 'n2' }]
          }
        }
      ],
      questions: []
    }

    await stampAnnotationAnchors(fx.dir, fakeSession(), ann)

    const [n1, n2, n3] = ann.sections[0].diagram!.nodes
    expect(n1.anchor).toMatchObject({ kind: 'diff' })
    expect((n1.anchor as DiffAnchor).stamp).toBeTruthy()
    expect((n1.anchor as DiffAnchor).stamp!.headSha).toBe(fx.shas.head)
    expect(n2.anchor).toEqual({ kind: 'file', file: 'src/a.ts' }) // non-diff anchor untouched
    expect(n3.anchor).toBeUndefined()
  })

  it('resolves the tree facts ONCE for the whole pass, not once per anchor', async () => {
    const anchorAt = (line: number): FocusTarget =>
      ({ kind: 'diff', file: 'src/a.ts', side: 'new', line, hunkRange: '', lineContent: '' })
    const ann: ReviewAnnotations = {
      title: 't', summary: 's',
      sections: [
        {
          id: 'a', name: 'A', files: ['src/a.ts'],
          narration: [{ text: 'one', anchor: anchorAt(1) }, { text: 'two', anchor: anchorAt(2) }],
          diagram: {
            why: 'why', caption: 'cap', edges: [],
            nodes: [
              { id: 'n1', label: 'One', kind: 'plain', anchor: anchorAt(3) },
              { id: 'n2', label: 'Two', kind: 'plain', anchor: anchorAt(4) }
            ]
          }
        }
      ],
      questions: []
    }
    // headSha/mergeBase answer the same for every anchor in one pass — four anchors
    // must not cost four rev-parse + four merge-base spawns.
    const head = vi.spyOn(git, 'headSha')
    const mb = vi.spyOn(git, 'mergeBase')
    try {
      await stampAnnotationAnchors(fx.dir, fakeSession(), ann)
      expect(head).toHaveBeenCalledTimes(1)
      expect(mb).toHaveBeenCalledTimes(1)
    } finally {
      head.mockRestore()
      mb.mockRestore()
    }
    for (const b of ann.sections[0].narration) expect((b.anchor as DiffAnchor).stamp).toBeTruthy()
    for (const n of ann.sections[0].diagram!.nodes) expect((n.anchor as DiffAnchor).stamp).toBeTruthy()
  })

  it('never throws even against a non-repo workdir (stampAnchor degrades to unstamped)', async () => {
    const ann: ReviewAnnotations = {
      title: 't', summary: 's',
      sections: [
        {
          id: 'a', name: 'A', files: ['src/a.ts'],
          narration: [{ text: 'anchored', anchor: { kind: 'diff', file: 'src/a.ts', side: 'new', line: 2, hunkRange: '', lineContent: '' } }]
        }
      ],
      questions: []
    }
    const badSession: SessionMeta = {
      id: 2, repo: '/nonexistent/not-a-repo',
      pair: {
        base: { kind: 'branch', symbol: 'main', anchorSha: 'a'.repeat(40) },
        compare: { kind: 'branch', symbol: 'feature', anchorSha: 'b'.repeat(40) }
      },
      createdAt: 'now', updatedAt: 'now'
    }
    await expect(stampAnnotationAnchors('/nonexistent/not-a-repo', badSession, ann)).resolves.toBeUndefined()
    expect((ann.sections[0].narration[0].anchor as DiffAnchor).stamp).toBeUndefined()
  })
})
