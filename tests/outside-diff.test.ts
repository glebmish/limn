import { describe, expect, it } from 'vitest'
import { outsideDiffGroups, snippetLines } from '../src/renderer/lib/outsideDiff'
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
