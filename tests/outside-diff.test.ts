import { describe, expect, it } from 'vitest'
import { outsideDiffGroups, snippetLines } from '../src/renderer/lib/outsideDiff'
// the store first: derive.ts sits in an import cycle that must be entered from its index
import '../src/renderer/store'
import { diffFilePaths, sourceIsDiffFile } from '../src/renderer/store/derive'
import type { LoadedReview } from '../src/shared/ipc'
import type { Comment, CommentAnchor } from '../src/shared/types'

type DiffAnchor = Extract<CommentAnchor, { kind: 'diff' }>
const diffAnchor = (file: string, line: number, over: Partial<DiffAnchor> = {}): DiffAnchor =>
  ({ kind: 'diff', file, side: 'new', line, hunkRange: '', lineContent: `L${line}`, ...over })

const cmt = (id: string, anchor: CommentAnchor, over: Partial<Comment> = {}): Comment => ({
  id, anchor, author: 'agent', text: id, status: 'proposed', replies: [], createdAt: '2026-09-16T00:00:00Z', iteration: 1, ...over
})

const known = new Set(['src/a.ts', 'src/b.ts'])

describe('outsideDiffGroups', () => {
  it('collects diff-anchored comments whose file is not in the diff, grouped by file in path order, lines ascending', () => {
    const groups = outsideDiffGroups([
      cmt('z9', diffAnchor('src/z.ts', 9)),
      cmt('m40', diffAnchor('src/m.ts', 40)),
      cmt('m12', diffAnchor('src/m.ts', 12))
    ], known)
    expect(groups.map((g) => g.file)).toEqual(['src/m.ts', 'src/z.ts'])
    expect(groups[0].comments.map((c) => c.id)).toEqual(['m12', 'm40'])
  })

  it('leaves comments on files that ARE in the diff to the per-file footers', () => {
    const groups = outsideDiffGroups([cmt('a', diffAnchor('src/a.ts', 3, {}), { notInDiff: true })], known)
    expect(groups).toEqual([])
  })

  it('hides dismissed proposals, like every other surface', () => {
    const groups = outsideDiffGroups([cmt('d', diffAnchor('src/z.ts', 1), { status: 'dismissed' })], known)
    expect(groups).toEqual([])
  })

  it('ignores non-positional anchors (file / section / summary)', () => {
    const groups = outsideDiffGroups([cmt('f', { kind: 'file', file: 'src/z.ts' })], known)
    expect(groups).toEqual([])
  })
})

describe('snippetLines', () => {
  it('numbers the stamped context from the real line numbers and marks the anchor line', () => {
    const a = diffAnchor('src/z.ts', 35, { lineContent: 'export async function f() {', context: { before: ['/** a', ' *  b', ' */'], after: ['  x', '  y', '}'] } })
    expect(snippetLines(a)).toEqual([
      { n: 32, text: '/** a', hit: false },
      { n: 33, text: ' *  b', hit: false },
      { n: 34, text: ' */', hit: false },
      { n: 35, text: 'export async function f() {', hit: true },
      { n: 36, text: '  x', hit: false },
      { n: 37, text: '  y', hit: false },
      { n: 38, text: '}', hit: false }
    ])
  })

  it('handles a short "before" at the top of a file', () => {
    const a = diffAnchor('src/z.ts', 2, { lineContent: 'two', context: { before: ['one'], after: ['three'] } })
    expect(snippetLines(a).map((l) => l.n)).toEqual([1, 2, 3])
  })

  it('marks every line of a range as hit', () => {
    const a = diffAnchor('src/z.ts', 10, { endLine: 12, lineContent: 'ten', context: { before: ['nine'], after: ['eleven', 'twelve', 'thirteen'] } })
    expect(snippetLines(a).filter((l) => l.hit).map((l) => l.n)).toEqual([10, 11, 12])
  })

  it('falls back to the single anchor line when the anchor carries no context', () => {
    const a = diffAnchor('src/z.ts', 7, { lineContent: 'seven' })
    expect(snippetLines(a)).toEqual([{ n: 7, text: 'seven', hit: true }])
  })
})

describe('diffFilePaths (#12)', () => {
  const f = (path: string, over: Record<string, unknown> = {}) => ({ path, status: 'modified', binary: false, add: 1, del: 0, hunks: [], ...over })
  const loaded = (dirty: boolean) => ({
    skeleton: { headSha: 'HEAD', files: [f('src/a.ts'), f('src/reverted.ts')] },
    merged: [f('src/a.ts'), f('src/wt.ts'), f('junk.log', { untracked: true, status: 'added' })],
    state: { fileExcluded: { 'junk.log': true }, annotations: null },
    dirty
  }) as unknown as LoadedReview
  it('follows the list the review renders: the merged diff when dirty, minus excluded files', () => {
    expect([...diffFilePaths(loaded(true))].sort()).toEqual(['src/a.ts', 'src/wt.ts'])
  })
  it('is the committed list on a clean tree', () => {
    expect([...diffFilePaths(loaded(false))].sort()).toEqual(['src/a.ts', 'src/reverted.ts'])
  })
  it('is empty with nothing loaded', () => {
    expect(diffFilePaths(null).size).toBe(0)
  })
  // an acceptance source on an excluded code file still jumps to the diff, never
  // opens the file as a rendered document
  it('sourceIsDiffFile keeps excluded files, follows the rendered list, and rejects artifacts', () => {
    expect(sourceIsDiffFile(loaded(true), 'junk.log')).toBe(true)
    expect(sourceIsDiffFile(loaded(true), 'src/wt.ts')).toBe(true)
    expect(sourceIsDiffFile(loaded(true), 'src/reverted.ts')).toBe(false)
    expect(sourceIsDiffFile(loaded(true), 'docs/spec.md')).toBe(false)
    expect(sourceIsDiffFile(null, 'src/a.ts')).toBe(false)
  })
})
