import { describe, expect, it } from 'vitest'
import type { DiffSkeleton, FileDiff } from '../src/shared/types'
import { SCOPE_MAX_FILES, SCOPE_MAX_LINES, SCOPE_MAX_FILE_RATIO, scopedEligible } from '../src/main/engines/scope'

function file(path: string, add = 0, del = 0, binary = false): FileDiff {
  return { path, status: 'modified', binary, add, del, hunks: [] }
}

function skeleton(fileCount: number): DiffSkeleton {
  const files: FileDiff[] = []
  for (let i = 0; i < fileCount; i++) files.push(file(`full/f${i}.ts`))
  return { base: 'main', branch: 'feat', mergeBase: 'abc', headSha: 'def', files }
}

// A generously large full diff so the ratio guard never fires unless a test intends it to.
const bigFull = skeleton(1000)

describe('scopedEligible', () => {
  describe('file cap', () => {
    it(`is eligible at exactly ${SCOPE_MAX_FILES} changed files`, () => {
      const since = Array.from({ length: SCOPE_MAX_FILES }, (_, i) => file(`f${i}.ts`, 1, 0))
      expect(scopedEligible(since, bigFull)).toBe(true)
    })

    it(`is not eligible at ${SCOPE_MAX_FILES + 1} changed files`, () => {
      const since = Array.from({ length: SCOPE_MAX_FILES + 1 }, (_, i) => file(`f${i}.ts`, 1, 0))
      expect(scopedEligible(since, bigFull)).toBe(false)
    })
  })

  describe('line budget', () => {
    it(`is eligible when Σ(add+del) equals ${SCOPE_MAX_LINES}`, () => {
      const since = [file('a.ts', 600, 400)] // 1000 lines, 1 file
      expect(scopedEligible(since, bigFull)).toBe(true)
    })

    it(`is not eligible when Σ(add+del) equals ${SCOPE_MAX_LINES + 1}`, () => {
      const since = [file('a.ts', 600, 401)] // 1001 lines, 1 file
      expect(scopedEligible(since, bigFull)).toBe(false)
    })

    it('counts a binary file as 1 file and 0 lines regardless of add/del', () => {
      // A binary file at the exact line budget stays eligible because its add/del
      // (which git reports as 0 for binaries anyway) do not count toward the budget.
      const since = [file('a.ts', 500, 500), file('img.png', 0, 0, true)]
      expect(scopedEligible(since, bigFull)).toBe(true)
    })

    it('does not count add/del of a binary file toward the line budget', () => {
      // Even if a binary FileDiff carries nonzero add/del, they must be ignored.
      const since = [file('a.ts', 500, 500), file('blob.bin', 9999, 9999, true)]
      expect(scopedEligible(since, bigFull)).toBe(true)
    })
  })

  describe('ratio guard', () => {
    it(`is not eligible when changed files exceed ${SCOPE_MAX_FILE_RATIO} × full.files.length`, () => {
      // 3 changed files against a 4-file branch = 0.75 > 0.5, under both K and T.
      const since = [file('a.ts', 1, 0), file('b.ts', 1, 0), file('c.ts', 1, 0)]
      expect(scopedEligible(since, skeleton(4))).toBe(false)
    })

    it(`is eligible at exactly ${SCOPE_MAX_FILE_RATIO} × full.files.length`, () => {
      // 2 changed files against a 4-file branch = 0.5, at the boundary.
      const since = [file('a.ts', 1, 0), file('b.ts', 1, 0)]
      expect(scopedEligible(since, skeleton(4))).toBe(true)
    })
  })

  describe('combined', () => {
    it('is eligible when under all three thresholds', () => {
      const since = [file('a.ts', 10, 5), file('b.ts', 3, 2)]
      expect(scopedEligible(since, skeleton(100))).toBe(true)
    })

    it('fails on the file-cap axis alone', () => {
      // 9 files, only 1 line each, tiny fraction of a big branch — only K is violated.
      const since = Array.from({ length: SCOPE_MAX_FILES + 1 }, (_, i) => file(`f${i}.ts`, 1, 0))
      expect(scopedEligible(since, skeleton(1000))).toBe(false)
    })

    it('fails on the line-budget axis alone', () => {
      // 1 file, 1001 lines, tiny fraction of a big branch — only T is violated.
      const since = [file('a.ts', SCOPE_MAX_LINES + 1, 0)]
      expect(scopedEligible(since, skeleton(1000))).toBe(false)
    })

    it('fails on the ratio axis alone', () => {
      // 3 files, few lines, but > 50% of a 4-file branch — only the ratio is violated.
      const since = [file('a.ts', 1, 0), file('b.ts', 1, 0), file('c.ts', 1, 0)]
      expect(scopedEligible(since, skeleton(4))).toBe(false)
    })
  })

  it('is eligible for an empty since-diff', () => {
    expect(scopedEligible([], bigFull)).toBe(true)
  })
})
