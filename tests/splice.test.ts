import { describe, expect, it } from 'vitest'
import type { AgentQuestion, DiffSkeleton, PlanMap, ReviewAnnotations, Section } from '../src/shared/types'
import type { ScopedReviewPatch, WireSection } from '../src/main/engines/schema'
import { SpliceError, spliceScopedUpdate } from '../src/main/engines/splice'

// ── fixtures ───────────────────────────────────────────────────
function psec(over: Partial<Section> & Pick<Section, 'id' | 'order'>): Section {
  return { name: over.id, desc: `desc ${over.id}`, what: `what ${over.id}`, files: [], ...over }
}

function wsec(over: Partial<WireSection> & Pick<WireSection, 'id' | 'order'>): WireSection {
  return {
    name: over.id, desc: `desc ${over.id}`, what: `what ${over.id}`, files: [],
    diagram: null, insight: null, plainNotes: null, ...over
  }
}

function prior(sections: Section[], over: Partial<ReviewAnnotations> = {}): ReviewAnnotations {
  return { title: 'Prior title', summary: 'Prior summary', sections, questions: [], ...over }
}

function patch(over: Partial<ScopedReviewPatch> = {}): ScopedReviewPatch {
  return {
    title: null, summary: null, revisedSections: [], deletedSectionIds: [],
    keptSectionIds: [], newQuestions: [], resolvedQuestionIds: [], planMap: null, ...over
  }
}

/** A skeleton whose tracked files are exactly `paths`, so mergeAnnotations neither
 *  sweeps strays nor drops references unless a test intends it. */
function skel(paths: string[]): DiffSkeleton {
  return {
    base: 'main', branch: 'feat', mergeBase: 'm0', headSha: 'h0',
    files: paths.map((p) => ({ path: p, status: 'modified' as const, binary: false, add: 1, del: 0, hunks: [] }))
  }
}

function allFiles(a: ReviewAnnotations): string[] {
  return a.sections.flatMap((s) => s.files).sort()
}

describe('spliceScopedUpdate', () => {
  describe('assembly', () => {
    it('revises a section body but keeps its id and order/position', () => {
      const p = prior([
        psec({ id: 's1', order: 1, files: ['a.ts'] }),
        psec({ id: 's2', order: 2, files: ['b.ts'] })
      ])
      const out = spliceScopedUpdate(
        p,
        patch({
          revisedSections: [wsec({ id: 's1', order: 1, name: 'Renamed', what: 'new narration', files: ['a.ts'] })],
          keptSectionIds: ['s2']
        }),
        skel(['a.ts', 'b.ts']),
        new Set()
      )
      expect(out.annotations.sections.map((s) => s.id)).toEqual(['s1', 's2'])
      expect(out.annotations.sections[0].name).toBe('Renamed')
      expect(out.annotations.sections[0].what).toBe('new narration')
      expect(out.annotations.sections[0].order).toBe(1)
      expect(out.annotations.sections[1].id).toBe('s2')
      expect(out.revisedCount).toBe(1)
      expect(out.keptCount).toBe(1)
    })

    it('inserts a new section by its order field then renormalizes order to 1..n', () => {
      const p = prior([
        psec({ id: 's1', order: 1, files: ['a.ts'] }),
        psec({ id: 's2', order: 3, files: ['b.ts'] })
      ])
      const out = spliceScopedUpdate(
        p,
        patch({
          revisedSections: [wsec({ id: 'sNew', order: 2, files: ['c.ts'] })],
          keptSectionIds: ['s1', 's2']
        }),
        skel(['a.ts', 'b.ts', 'c.ts']),
        new Set()
      )
      expect(out.annotations.sections.map((s) => s.id)).toEqual(['s1', 'sNew', 's2'])
      expect(out.annotations.sections.map((s) => s.order)).toEqual([1, 2, 3])
      expect(out.revisedCount).toBe(0)
      expect(out.keptCount).toBe(2)
    })

    it('drops a deleted section', () => {
      const p = prior([
        psec({ id: 's1', order: 1, files: ['a.ts'] }),
        psec({ id: 's2', order: 2, files: ['b.ts'] })
      ])
      const out = spliceScopedUpdate(
        p,
        patch({ deletedSectionIds: ['s2'], keptSectionIds: ['s1'] }),
        skel(['a.ts']),
        new Set()
      )
      expect(out.annotations.sections.map((s) => s.id)).toEqual(['s1'])
      expect(out.keptCount).toBe(1)
    })
  })

  describe('file move', () => {
    it('removes a claimed file from a kept section and drops the emptied section', () => {
      const p = prior([
        psec({ id: 's1', order: 1, files: ['a.ts'] }),
        psec({ id: 's2', order: 2, files: ['b.ts'] })
      ])
      // s2 revised to also claim a.ts; s1 kept — its only file moves away → dropped.
      const out = spliceScopedUpdate(
        p,
        patch({
          revisedSections: [wsec({ id: 's2', order: 2, files: ['b.ts', 'a.ts'] })],
          keptSectionIds: ['s1']
        }),
        skel(['a.ts', 'b.ts']),
        new Set()
      )
      expect(out.annotations.sections.map((s) => s.id)).toEqual(['s2'])
      expect(out.annotations.sections[0].files.sort()).toEqual(['a.ts', 'b.ts'])
      expect(out.keptCount).toBe(0)
      expect(out.revisedCount).toBe(1)
    })

    it('strips a claimed file from a kept section that still has other files', () => {
      const p = prior([
        psec({ id: 's1', order: 1, files: ['a.ts', 'keep.ts'] }),
        psec({ id: 's2', order: 2, files: ['b.ts'] })
      ])
      const out = spliceScopedUpdate(
        p,
        patch({
          revisedSections: [wsec({ id: 's2', order: 2, files: ['b.ts', 'a.ts'] })],
          keptSectionIds: ['s1']
        }),
        skel(['a.ts', 'b.ts', 'keep.ts']),
        new Set()
      )
      const s1 = out.annotations.sections.find((s) => s.id === 's1')!
      expect(s1.files).toEqual(['keep.ts'])
      expect(out.keptCount).toBe(1)
    })
  })

  describe('handshake', () => {
    const p = prior([
      psec({ id: 's1', order: 1, files: ['a.ts'] }),
      psec({ id: 's2', order: 2, files: ['b.ts'] })
    ])
    const sk = skel(['a.ts', 'b.ts'])

    it('throws when a prior id is unaccounted for', () => {
      expect(() => spliceScopedUpdate(p, patch({ keptSectionIds: ['s1'] }), sk, new Set())).toThrow(SpliceError)
    })

    it('throws when a kept id is not a prior id', () => {
      expect(() =>
        spliceScopedUpdate(p, patch({ keptSectionIds: ['s1', 's2', 'ghost'] }), sk, new Set())
      ).toThrow(SpliceError)
    })

    it('throws when a deleted id is not a prior id', () => {
      expect(() =>
        spliceScopedUpdate(p, patch({ deletedSectionIds: ['ghost'], keptSectionIds: ['s1', 's2'] }), sk, new Set())
      ).toThrow(SpliceError)
    })

    it('throws on a duplicate id within revisedSections', () => {
      expect(() =>
        spliceScopedUpdate(
          p,
          patch({
            revisedSections: [wsec({ id: 's1', order: 1, files: ['a.ts'] }), wsec({ id: 's1', order: 1, files: ['a.ts'] })],
            keptSectionIds: ['s2']
          }),
          sk,
          new Set()
        )
      ).toThrow(SpliceError)
    })

    it('throws when an id is both kept and deleted (overlap)', () => {
      expect(() =>
        spliceScopedUpdate(p, patch({ keptSectionIds: ['s1', 's2'], deletedSectionIds: ['s2'] }), sk, new Set())
      ).toThrow(SpliceError)
    })

    it('throws when an id is both revised and kept (overlap)', () => {
      expect(() =>
        spliceScopedUpdate(
          p,
          patch({ revisedSections: [wsec({ id: 's1', order: 1, files: ['a.ts'] })], keptSectionIds: ['s1', 's2'] }),
          sk,
          new Set()
        )
      ).toThrow(SpliceError)
    })
  })

  describe('garbage guard', () => {
    it('throws when more than 50% of prior sections are deleted', () => {
      const p = prior([
        psec({ id: 's1', order: 1, files: ['a.ts'] }),
        psec({ id: 's2', order: 2, files: ['b.ts'] }),
        psec({ id: 's3', order: 3, files: ['c.ts'] })
      ])
      expect(() =>
        spliceScopedUpdate(p, patch({ deletedSectionIds: ['s1', 's2'], keptSectionIds: ['s3'] }), skel(['c.ts']), new Set())
      ).toThrow(SpliceError)
    })

    it('does NOT throw at exactly 50% deleted', () => {
      const p = prior([
        psec({ id: 's1', order: 1, files: ['a.ts'] }),
        psec({ id: 's2', order: 2, files: ['b.ts'] })
      ])
      expect(() =>
        spliceScopedUpdate(p, patch({ deletedSectionIds: ['s1'], keptSectionIds: ['s2'] }), skel(['b.ts']), new Set())
      ).not.toThrow()
    })

    it('throws when every prior section is revised (engine ignored scoping)', () => {
      const p = prior([
        psec({ id: 's1', order: 1, files: ['a.ts'] }),
        psec({ id: 's2', order: 2, files: ['b.ts'] })
      ])
      expect(() =>
        spliceScopedUpdate(
          p,
          patch({
            revisedSections: [
              wsec({ id: 's1', order: 1, files: ['a.ts'] }),
              wsec({ id: 's2', order: 2, files: ['b.ts'] })
            ]
          }),
          skel(['a.ts', 'b.ts']),
          new Set()
        )
      ).toThrow(SpliceError)
    })
  })

  describe('questions', () => {
    it('resolves listed questions and appends new ones, deduping against survivors', () => {
      const questions: AgentQuestion[] = [
        { id: 'q1', text: 'Q1?' },
        { id: 'q2', text: 'Q2?' }
      ]
      const p = prior([psec({ id: 's1', order: 1, files: ['a.ts'] })], { questions })
      const out = spliceScopedUpdate(
        p,
        patch({
          keptSectionIds: ['s1'],
          resolvedQuestionIds: ['q1'],
          newQuestions: [
            { id: 'q3', text: 'Q3?', context: null, options: [] },
            { id: 'q2', text: 'dup of survivor', context: null, options: [] }
          ]
        }),
        skel(['a.ts']),
        new Set()
      )
      expect(out.annotations.questions.map((q) => q.id)).toEqual(['q2', 'q3'])
      // the surviving q2 keeps its original text; the dup new-q2 is discarded
      expect(out.annotations.questions.find((q) => q.id === 'q2')!.text).toBe('Q2?')
    })
  })

  describe('scalars', () => {
    const planMap: PlanMap = {
      acceptance: [{ text: 'works', met: true }],
      steps: [{ n: 1, text: 'do a', sectionId: 's1', status: 'done' }],
      deviations: []
    }

    it('keeps prior title/summary/planMap when the patch scalar is null', () => {
      const p = prior([psec({ id: 's1', order: 1, files: ['a.ts'] })], { planMap })
      const out = spliceScopedUpdate(p, patch({ keptSectionIds: ['s1'] }), skel(['a.ts']), new Set())
      expect(out.annotations.title).toBe('Prior title')
      expect(out.annotations.summary).toBe('Prior summary')
      expect(out.annotations.planMap).toEqual(planMap)
    })

    it('replaces title/summary when the patch supplies them', () => {
      const p = prior([psec({ id: 's1', order: 1, files: ['a.ts'] })])
      const out = spliceScopedUpdate(
        p,
        patch({ title: 'New title', summary: 'New summary', keptSectionIds: ['s1'] }),
        skel(['a.ts']),
        new Set()
      )
      expect(out.annotations.title).toBe('New title')
      expect(out.annotations.summary).toBe('New summary')
    })
  })

  describe('new-section id collision', () => {
    it("re-mints a new id colliding with 'other-changes' and rewrites planMap references", () => {
      const p = prior([psec({ id: 's1', order: 1, files: ['a.ts'] })])
      const out = spliceScopedUpdate(
        p,
        patch({
          revisedSections: [wsec({ id: 'other-changes', order: 2, files: ['b.ts'] })],
          keptSectionIds: ['s1'],
          planMap: {
            acceptance: [],
            steps: [{ n: 1, text: 'new file work', sectionId: 'other-changes', status: 'done' }],
            deviations: [{ text: 'moved logic', sectionId: 'other-changes' }]
          }
        }),
        skel(['a.ts', 'b.ts']),
        new Set()
      )
      expect(out.annotations.sections.map((s) => s.id).sort()).toEqual(['other-changes-2', 's1'])
      expect(out.annotations.planMap!.steps[0].sectionId).toBe('other-changes-2')
      expect(out.annotations.planMap!.deviations[0].sectionId).toBe('other-changes-2')
    })
  })

  describe('end-to-end through mergeAnnotations', () => {
    it('sweeps a drift-added unclaimed file to Other changes with a warning, coverage stays 100%', () => {
      const p = prior([psec({ id: 's1', order: 1, files: ['a.ts'] })])
      // current skeleton has a since-added file the engine never claimed.
      const out = spliceScopedUpdate(
        p,
        patch({ keptSectionIds: ['s1'] }),
        skel(['a.ts', 'new.ts']),
        new Set(),
        new Set(['new.ts'])
      )
      const other = out.annotations.sections.find((s) => s.id === 'other-changes')
      expect(other).toBeDefined()
      expect(other!.files).toEqual(['new.ts'])
      // coverage: every tracked skeleton file is assigned to exactly one section
      expect(allFiles(out.annotations)).toEqual(['a.ts', 'new.ts'])
      expect(out.warnings.some((w) => w.includes('new.ts'))).toBe(true)
    })

    it('does not warn when a drift-added file was claimed by a revised section', () => {
      const p = prior([
        psec({ id: 's1', order: 1, files: ['a.ts'] }),
        psec({ id: 's2', order: 2, files: ['b.ts'] })
      ])
      const out = spliceScopedUpdate(
        p,
        patch({
          revisedSections: [wsec({ id: 's1', order: 1, files: ['a.ts', 'new.ts'] })],
          keptSectionIds: ['s2']
        }),
        skel(['a.ts', 'b.ts', 'new.ts']),
        new Set(),
        new Set(['new.ts'])
      )
      expect(out.annotations.sections.find((s) => s.id === 'other-changes')).toBeUndefined()
      expect(out.warnings.some((w) => w.includes('new.ts'))).toBe(false)
    })
  })
})
