import { describe, expect, it } from 'vitest'
import type { DiffLine, Hunk } from '../src/shared/types'
import { buildMultiRows, multiGaps } from '../src/renderer/lib/rowsMulti'
import { buildFileRows, runHighlight, type AlignedRow } from '../src/renderer/lib/rows'
import { hunkGaps } from '../src/renderer/lib/expand'

const aligned = (rows: ReturnType<typeof buildMultiRows>) => rows.filter((r): r is AlignedRow => r.type === 'aligned')
// base: l1..l6. checkpoint: replaced l3 with X, added `const y = 1` after l4.
// now: replaced l3 with X, added `const y = 2` after l4, deleted l6.
const mid: Hunk[] = [{ range: '@@ -1,6 +1,7 @@', header: '', lines: [
  { old: 1, new: 1, kind: '', text: 'l1' }, { old: 2, new: 2, kind: '', text: 'l2' },
  { old: 3, new: null, kind: 'del', text: 'l3' }, { old: null, new: 3, kind: 'add', text: 'X' },
  { old: 4, new: 4, kind: '', text: 'l4' }, { old: null, new: 5, kind: 'add', text: 'const y = 1' },
  { old: 5, new: 6, kind: '', text: 'l5' }, { old: 6, new: 7, kind: '', text: 'l6' }
] }]
const now: Hunk[] = [{ range: '@@ -1,6 +1,6 @@', header: '', lines: [
  { old: 1, new: 1, kind: '', text: 'l1' }, { old: 2, new: 2, kind: '', text: 'l2' },
  { old: 3, new: null, kind: 'del', text: 'l3' }, { old: null, new: 3, kind: 'add', text: 'X', since: true },
  { old: 4, new: 4, kind: '', text: 'l4' }, { old: null, new: 5, kind: 'add', text: 'const y = 2', origin: 'unstaged' },
  { old: 5, new: 6, kind: '', text: 'l5' }, { old: 6, new: null, kind: 'del', text: 'l6' }
] }]

describe('buildMultiRows', () => {
  it('aligns on base lines with one cell per column', () => {
    const rows = aligned(buildMultiRows([mid], now, multiGaps([mid], now), null))
    expect(rows.map((r) => r.key)).toEqual(['old:1', 'old:2', 'old:3', 'new:3', 'old:4', 'new:5', 'old:5', 'old:6'])
    expect(rows[0].cells.map((c) => c.lineNo)).toEqual([1, 1, 1])
    expect(rows[0].cells.map((c) => c.side)).toEqual(['old', 'mid', 'new'])
    expect(rows[6].cells.map((c) => c.lineNo)).toEqual([5, 6, 6]) // mid shifted by its insert, now by its own
  })

  it('a replacement covered by the checkpoint is plain; a divergent insertion is `since`, the checkpoint\'s own is `gone`', () => {
    const rows = aligned(buildMultiRows([mid], now, multiGaps([mid], now), null))
    const x = rows.find((r) => r.key === 'new:3')!
    expect(x.cells[0]).toMatchObject({ l: null, side: 'old', lineNo: null })
    expect(x.cells[1]).toMatchObject({ l: { text: 'X' }, side: 'mid', lineNo: 3, kind: 'add' })
    expect(x.cells[2]).toMatchObject({ l: { text: 'X' }, side: 'new', lineNo: 3, kind: 'add' })
    expect(x.cells[2].attribution).toBeUndefined()
    expect(x.cells[1].attribution).toBeUndefined()
    const yz = rows.find((r) => r.key === 'new:5')!
    expect(yz.cells[1]).toMatchObject({ l: { text: 'const y = 1' }, attribution: 'gone' })
    expect(yz.cells[2]).toMatchObject({ l: { text: 'const y = 2', origin: 'unstaged' }, attribution: 'since' })
    expect(yz.cells[2].marks).toEqual([{ start: 10, len: 1 }])
    expect(yz.run).toEqual({ lines: now[0].lines, idx: 5 })
    expect(yz.anchor).toEqual({ side: 'new', lineNo: 5 })
  })

  it('a base line deleted in one column is an empty deleted slot there', () => {
    const rows = aligned(buildMultiRows([mid], now, multiGaps([mid], now), null))
    const six = rows.find((r) => r.key === 'old:6')!
    expect(six.cells[0]).toMatchObject({ side: 'old', lineNo: 6, kind: 'del' })
    expect(six.cells[1]).toMatchObject({ side: 'mid', lineNo: 7, kind: '', l: { text: 'l6' } })
    expect(six.cells[2]).toMatchObject({ l: null, deleted: true, attribution: 'since' })
    expect(six.anchor).toEqual({ side: 'old', lineNo: 6 })
    expect(six.run).toEqual({ lines: now[0].lines, idx: 7 })
    const three = rows.find((r) => r.key === 'old:3')!
    expect(three.cells[0]).toMatchObject({ kind: 'del' })
    expect(three.cells[1]).toMatchObject({ deleted: true })
    expect(three.cells[1].attribution).toBeUndefined()
    expect(three.cells[2]).toMatchObject({ deleted: true })
    expect(three.cells[2].attribution).toBeUndefined()
  })

  it('anchors a kept line on its now number and carries its run for discard', () => {
    const rows = aligned(buildMultiRows([mid], now, multiGaps([mid], now), null))
    const four = rows.find((r) => r.key === 'old:4')!
    expect(four.anchor).toEqual({ side: 'new', lineNo: 4 })
    expect(four.run).toEqual({ lines: now[0].lines, idx: 4 })
    expect(four.cells[2].l).toMatchObject({ old: 4, new: 4 })
  })

  it('a base line only the checkpoint touched still gets a now cell numbered in now space', () => {
    // mid deletes base 20 inside its own hunk; now never touched that region (one insert at 5)
    const midB: Hunk[] = [{ range: '@@ -18,5 +18,4 @@', header: '', lines: [
      { old: 18, new: 18, kind: '', text: 'p' }, { old: 19, new: 19, kind: '', text: 'q' },
      { old: 20, new: null, kind: 'del', text: 'r' }, { old: 21, new: 20, kind: '', text: 's' }, { old: 22, new: 21, kind: '', text: 't' }
    ] }]
    const nowB: Hunk[] = [{ range: '@@ -4,2 +4,3 @@', header: '', lines: [
      { old: 4, new: 4, kind: '', text: 'a' }, { old: null, new: 5, kind: 'add', text: 'N' }, { old: 5, new: 6, kind: '', text: 'b' }
    ] }]
    const rows = aligned(buildMultiRows([midB], nowB, multiGaps([midB], nowB), null))
    const r = rows.find((x) => x.key === 'old:20')!
    // the checkpoint's EMPTY slot says nothing — it is current that diverged, and the
    // mark belongs on the line that actually has it ("a current line the checkpoint
    // beside it never had" = `since`)
    expect(r.cells[1]).toMatchObject({ deleted: true })
    expect(r.cells[1].attribution).toBeUndefined()
    expect(r.cells[2]).toMatchObject({ lineNo: 21, kind: '', l: { text: 'r', new: 21 }, attribution: 'since' })
    // not inside a now hunk: real content, but no anchor payload to hand the pipeline
    expect(r.anchor).toBeNull()
    expect(r.run).toBeNull()
  })

  it('lays gaps between covered segments in now coordinates with both offsets', () => {
    const midB: Hunk[] = [{ range: '@@ -10,3 +10,4 @@', header: '', lines: [
      { old: 10, new: 10, kind: '', text: 'a' }, { old: null, new: 11, kind: 'add', text: 'M' },
      { old: 11, new: 12, kind: '', text: 'b' }, { old: 12, new: 13, kind: '', text: 'c' }
    ] }]
    const nowB: Hunk[] = [{ range: '@@ -30,2 +30,3 @@', header: 'fn g()', lines: [
      { old: 30, new: 30, kind: '', text: 'p' }, { old: null, new: 31, kind: 'add', text: 'N' }, { old: 31, new: 32, kind: '', text: 'q' }
    ] }]
    expect(multiGaps([midB], nowB)).toEqual([
      { key: 'g1', from: 1, to: 9, oldOffset: 0, midOffsets: [0] },
      { key: 'g13', from: 13, to: 29, oldOffset: 0, midOffsets: [-1] },
      { key: 'g33', from: 33, to: null, oldOffset: 1, midOffsets: [0] }
    ])
    const rows = buildMultiRows([midB], nowB, multiGaps([midB], nowB), null)
    expect(rows.filter((r) => r.type === 'gap').map((r) => r.key)).toEqual(['gap:g1', 'gap:g13', 'gap:g33'])
    expect(rows.filter((r) => r.type === 'gap').map((r) => (r as { fn: string }).fn)).toEqual(['', 'g', ''])
    const seg2 = rows.find((r) => r.type === 'aligned' && r.key === 'old:30') as AlignedRow
    expect(seg2.cells.map((c) => c.lineNo)).toEqual([30, 31, 30]) // mid kept the line, one insertion above it
    expect(buildMultiRows([midB], nowB, multiGaps([midB], nowB), null, { trailing: false }).filter((r) => r.type === 'gap').map((r) => r.key)).toEqual(['gap:g1', 'gap:g13'])
  })

  // as in `buildFileRows`: there is no file below a wholly-deleted one, so offering a
  // run trailing off under its last row asserts hidden lines the reader cannot
  // disprove. DiffBody only masks it once a failed read makes the fold inert — on
  // first render it is painted and clickable.
  it('offers no trailing run on a wholly-deleted file', () => {
    const gone: Hunk[] = [{ range: '@@ -1,3 +0,0 @@', header: '', lines: [
      { old: 1, new: null, kind: 'del', text: 'a' },
      { old: 2, new: null, kind: 'del', text: 'b' },
      { old: 3, new: null, kind: 'del', text: 'c' }
    ] }]
    expect(buildMultiRows([gone], gone, multiGaps([gone], gone), null).filter((r) => r.type === 'gap')).toEqual([])
    // the two builders agree about the rule
    expect(buildFileRows(gone, hunkGaps(gone)).filter((r) => r.type === 'gap')).toEqual([])
  })

  it('insertions at end of file land after the last base line', () => {
    const midE: Hunk[] = []
    const nowE: Hunk[] = [{ range: '@@ -3,1 +3,2 @@', header: '', lines: [
      { old: 3, new: 3, kind: '', text: 'last' }, { old: null, new: 4, kind: 'add', text: 'tail' }
    ] }]
    const rows = aligned(buildMultiRows([midE], nowE, multiGaps([midE], nowE), null))
    expect(rows.map((r) => r.key)).toEqual(['old:3', 'new:4'])
    expect(rows[1].cells[2]).toMatchObject({ attribution: 'since', lineNo: 4 })
    expect(rows[1].cells[1]).toMatchObject({ l: null })
  })
})

// #7: a construct spanning several of a run's lines must keep its styling on every
// line it covers. Unified and Split go through `runHighlight`, and so do Multi's own
// revealed folds (`contextRows`) — a hunk cell tokenized on its own would lose the
// comment three rows above the fold that keeps it.
describe('buildMultiRows highlighting (#7)', () => {
  const commented = (range: string, tailNew: number): Hunk => ({ range, header: '', lines: [
    { old: 1, new: 1, kind: '', text: '/* a comment' },
    { old: 2, new: 2, kind: '', text: '   still comment' },
    { old: 3, new: 3, kind: '', text: '   ends here */' },
    { old: 4, new: null, kind: 'del', text: 'const a = 1' },
    { old: null, new: 4, kind: 'add', text: `const a = ${tailNew}` }
  ] })

  const midCol = [commented('@@ -1,4 +1,4 @@', 2)]
  const nowCol = [commented('@@ -1,4 +1,4 @@', 3)]

  it('highlights each column over the whole run, not line by line', () => {
    // the middle line of the comment, as Unified renders it
    const uni = buildFileRows(nowCol, [], 'typescript').find((r) => r.type === 'line' && r.key === 'new:2')
    const want = uni?.type === 'line' ? uni.html : undefined
    expect(want).toContain('hljs-comment')
    const two = aligned(buildMultiRows([midCol], nowCol, multiGaps([midCol], nowCol), 'typescript')).find((r) => r.key === 'old:2')!
    expect(two.cells.map((c) => c.html)).toEqual([want, want, want])
  })

  it('highlights an insertion cell in its own run too', () => {
    const add = aligned(buildMultiRows([midCol], nowCol, multiGaps([midCol], nowCol), 'typescript')).find((r) => r.key === 'new:4')!
    expect(add.cells[2].html).toContain('hljs-keyword') // `const`, from the new-side pass
    expect(add.cells[1].html).toContain('hljs-keyword')
  })

  it('gives each column the html from its OWN run, even when both columns hold the same line object', () => {
    // Two diffs normally hand us distinct DiffLine objects, so a lookup keyed only on
    // the object happened to land on the right column. Nothing guarantees that: here
    // one object sits in both columns, inside a comment in the checkpoint's run and
    // outside it in current's, and each cell must show its own column's tokenization.
    const shared: DiffLine = { old: 2, new: 2, kind: '', text: 'value = 1' }
    const col = (first: string, tail: string): Hunk => ({ range: '@@ -1,3 +1,3 @@', header: '', lines: [
      { old: 1, new: 1, kind: '', text: first }, shared,
      { old: 3, new: null, kind: 'del', text: 'gone' }, { old: null, new: 3, kind: 'add', text: tail }
    ] })
    const midRun = [col('/* an unclosed comment', 'const a = 1')]
    const nowRun = [col('const opened = 1', 'const a = 2')]

    const midWant = runHighlight(midRun[0].lines, 'typescript').new[1]
    const nowWant = runHighlight(nowRun[0].lines, 'typescript').new[1]
    expect(midWant).toContain('hljs-comment') // swallowed by the comment above it
    expect(midWant).not.toBe(nowWant)

    const row = aligned(buildMultiRows([midRun], nowRun, multiGaps([midRun], nowRun), 'typescript')).find((r) => r.key === 'old:2')!
    expect(row.cells[1].html).toBe(midWant)
    expect(row.cells[2].html).toBe(nowWant)
    // the base cell reads the old side of the column the line came from (current here)
    expect(row.cells[0].html).toBe(runHighlight(nowRun[0].lines, 'typescript').old[1])
  })
})

describe('buildMultiRows with several checkpoint columns', () => {
  // base: l1 l2 l3. agent review inserted A after l2; approval inserted B after l2 and
  // deleted l3; current inserted B after l2 and kept l3.
  const review: Hunk[] = [{ range: '@@ -1,3 +1,4 @@', header: '', lines: [
    { old: 1, new: 1, kind: '', text: 'l1' }, { old: 2, new: 2, kind: '', text: 'l2' },
    { old: null, new: 3, kind: 'add', text: 'const a = 1' }, { old: 3, new: 4, kind: '', text: 'l3' }
  ] }]
  const approval: Hunk[] = [{ range: '@@ -1,3 +1,3 @@', header: '', lines: [
    { old: 1, new: 1, kind: '', text: 'l1' }, { old: 2, new: 2, kind: '', text: 'l2' },
    { old: null, new: 3, kind: 'add', text: 'const a = 2' }, { old: 3, new: null, kind: 'del', text: 'l3' }
  ] }]
  const current: Hunk[] = [{ range: '@@ -1,3 +1,4 @@', header: '', lines: [
    { old: 1, new: 1, kind: '', text: 'l1' }, { old: 2, new: 2, kind: '', text: 'l2' },
    { old: null, new: 3, kind: 'add', text: 'const a = 2' }, { old: 3, new: 4, kind: '', text: 'l3' }
  ] }]

  it('lays one cell per column, base · review · approval · current', () => {
    const rows = aligned(buildMultiRows([review, approval], current, multiGaps([review, approval], current), null))
    expect(rows.map((r) => r.key)).toEqual(['old:1', 'old:2', 'new:3', 'old:3'])
    expect(rows[0].cells.map((c) => c.side)).toEqual(['old', 'mid', 'mid', 'new'])
    expect(rows[3].cells.map((c) => c.lineNo)).toEqual([3, 4, null, 4])
  })

  it('attributes current against the NEAREST checkpoint only, and each checkpoint against current', () => {
    const rows = aligned(buildMultiRows([review, approval], current, multiGaps([review, approval], current), null))
    const ins = rows.find((r) => r.key === 'new:3')!
    expect(ins.cells[1]).toMatchObject({ l: { text: 'const a = 1' }, attribution: 'gone' })   // the review's own insert
    expect(ins.cells[2]).toMatchObject({ l: { text: 'const a = 2' } })
    expect(ins.cells[2].attribution).toBeUndefined()                                 // the approval already had B
    expect(ins.cells[3].attribution).toBeUndefined()                                 // current matches the approval
    // swap the order and current is now measured against the review: B is `since`
    const swapped = aligned(buildMultiRows([approval, review], current, multiGaps([approval, review], current), null)).find((r) => r.key === 'new:3')!
    expect(swapped.cells[3]).toMatchObject({ attribution: 'since' })
    expect(swapped.cells[3].marks).toEqual([{ start: 10, len: 1 }])
    expect(swapped.cells[2].marks).toEqual([{ start: 10, len: 1 }])
  })

  it('a base line one checkpoint deleted is a deleted slot in that column only', () => {
    const rows = aligned(buildMultiRows([review, approval], current, multiGaps([review, approval], current), null))
    const three = rows.find((r) => r.key === 'old:3')!
    expect(three.cells[1]).toMatchObject({ side: 'mid', lineNo: 4, l: { text: 'l3' } })
    expect(three.cells[2]).toMatchObject({ deleted: true })
    expect(three.cells[2].attribution).toBeUndefined()
    // the nearest checkpoint (the approval) dropped the line current still has: `since`
    expect(three.cells[3]).toMatchObject({ lineNo: 4, kind: '', attribution: 'since' })
  })

  it('keys a checkpoint-only insertion by its column so two checkpoints never collide', () => {
    const rows = aligned(buildMultiRows([review, approval], [], multiGaps([review, approval], []), null))
    expect(rows.map((r) => r.key)).toEqual(['old:1', 'old:2', 'mid0:3', 'old:3'])
  })

  // "wholly deleted" is a statement about CURRENT: a file current does not touch at
  // all still continues below its last shown row
  it('keeps the trailing run when only a checkpoint touched the file', () => {
    const rows = buildMultiRows([review, approval], [], multiGaps([review, approval], []), null)
    const tail = rows.filter((r) => r.type === 'gap').at(-1)
    expect(tail?.type === 'gap' && tail.where).toBe('below')
  })

  it('measures gaps with one offset per checkpoint column', () => {
    const r2: Hunk[] = [{ range: '@@ -10,2 +10,3 @@', header: '', lines: [
      { old: 10, new: 10, kind: '', text: 'a' }, { old: null, new: 11, kind: 'add', text: 'R' }, { old: 11, new: 12, kind: '', text: 'b' }
    ] }]
    const a2: Hunk[] = [{ range: '@@ -10,2 +10,4 @@', header: '', lines: [
      { old: 10, new: 10, kind: '', text: 'a' }, { old: null, new: 11, kind: 'add', text: 'P' }, { old: null, new: 12, kind: 'add', text: 'Q' }, { old: 11, new: 13, kind: '', text: 'b' }
    ] }]
    const n2: Hunk[] = [{ range: '@@ -30,2 +30,3 @@', header: '', lines: [
      { old: 30, new: 30, kind: '', text: 'p' }, { old: null, new: 31, kind: 'add', text: 'N' }, { old: 31, new: 32, kind: '', text: 'q' }
    ] }]
    expect(multiGaps([r2, a2], n2).map((g) => [g.from, g.to, g.oldOffset, g.midOffsets])).toEqual([
      [1, 9, 0, [0, 0]], [12, 29, 0, [-1, -2]], [33, null, 1, [0, -1]]
    ])
  })
})
