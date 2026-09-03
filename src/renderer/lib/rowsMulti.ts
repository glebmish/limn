import type { DiffLine, Hunk } from '../../shared/types'
import type { Gap } from './expand'
import { fnLabel, type Cell, type GapRow, type ViewRow } from './rows'
import { disp, highlightLine } from './highlight'
import { wordDiffRanges } from './worddiff'

/** The Multi layout's row builder: base · checkpoints · current, every side column
 *  diffed against base (base-relative hunk sets, all straight from git), rows aligned
 *  on base line numbers, and each divergence between a checkpoint and current
 *  attributed — `since` on a current line the nearest checkpoint never had, `gone`
 *  on a checkpoint line the tree no longer has. No cross-column diff is computed
 *  here: attribution is a text match at the same base position, nothing more.
 *
 *  `mids` are the checkpoint columns in display order (design board 13: up to
 *  three — agent review, approval, file view); the last one is the "nearest"
 *  checkpoint current is attributed against. */

interface Ins { l: DiffLine; hunk: Hunk; idx: number }

/** One side's view of the base, indexed by base line. */
interface SideIndex {
  /** base lines this side deleted */
  del: Set<number>
  /** base line → this side's number, for base lines a hunk shows as kept */
  kept: Map<number, number>
  /** base line → the hunk line (context or del) standing for it */
  lineAt: Map<number, { l: DiffLine; hunk: Hunk; idx: number }>
  /** base line → this side's insertions placed right before it (EOF inserts hang
   *  off `lastBase + 1`, a base line that does not exist) */
  insBefore: Map<number, Ins[]>
  /** every base line some hunk covers (plus the EOF insertion anchor) */
  covered: Set<number>
  hunkOf: Map<number, Hunk>
  /** this side's line = base + delta, for the last kept line at or before base */
  offsets: { from: number; delta: number }[]
}

function indexSide(hunks: Hunk[]): SideIndex {
  const ix: SideIndex = { del: new Set(), kept: new Map(), lineAt: new Map(), insBefore: new Map(), covered: new Set(), hunkOf: new Map(), offsets: [] }
  for (const h of hunks) {
    let pending: Ins[] = []
    let lastOld = 0
    h.lines.forEach((l, idx) => {
      if (l.kind === 'add') { pending.push({ l, hunk: h, idx }); return }
      if (l.old == null) return
      lastOld = l.old
      ix.covered.add(l.old)
      ix.hunkOf.set(l.old, h)
      ix.lineAt.set(l.old, { l, hunk: h, idx })
      if (pending.length) { ix.insBefore.set(l.old, pending); pending = [] }
      if (l.kind === 'del') ix.del.add(l.old)
      else if (l.new != null) { ix.kept.set(l.old, l.new); ix.offsets.push({ from: l.old, delta: l.new - l.old }) }
    })
    if (pending.length) {
      const eof = lastOld + 1
      ix.insBefore.set(eof, [...(ix.insBefore.get(eof) ?? []), ...pending])
      ix.covered.add(eof)
      ix.hunkOf.set(eof, h)
    }
  }
  return ix
}

function offsetAt(ix: SideIndex, base: number): number {
  let d = 0
  for (const o of ix.offsets) { if (o.from <= base) d = o.delta; else break }
  return d
}

function coveredBases(sides: SideIndex[]): number[] {
  return [...new Set(sides.flatMap((s) => [...s.covered]))].sort((a, b) => a - b)
}

/** Collapsed runs in CURRENT coordinates with offsets back to base (`oldOffset`) and
 *  to each checkpoint (`midOffsets`, one per mid), between the segments any side
 *  touched. A run is unchanged in every column, so one text fetch (the tree now)
 *  fills it. */
export function multiGaps(mids: Hunk[][], now: Hunk[]): Gap[] {
  const ims = mids.map(indexSide), inow = indexSide(now)
  const bases = coveredBases([...ims, inow])
  const gapFor = (baseFrom: number, baseTo: number | null): Gap => {
    const dNow = offsetAt(inow, baseFrom - 1)
    const from = baseFrom + dNow
    return { key: `g${from}`, from, to: baseTo == null ? null : baseTo + dNow, oldOffset: dNow, midOffsets: ims.map((im) => dNow - offsetAt(im, baseFrom - 1)) }
  }
  const gaps: Gap[] = []
  let cursor = 1
  let i = 0
  while (i < bases.length) {
    if (bases[i] > cursor) gaps.push(gapFor(cursor, bases[i] - 1))
    let j = i
    while (j + 1 < bases.length && bases[j + 1] === bases[j] + 1) j++
    cursor = bases[j] + 1
    i = j + 1
  }
  gaps.push(gapFor(cursor, null))
  return gaps
}

const pad = (side: Cell['side']): Cell => ({ l: null, side, lineNo: null, kind: '' })
const html = (l: DiffLine, lang: string | null): string => highlightLine(disp(l.text), lang)

/** Which insertions on one side the other side repeats at the same base position,
 *  matched by text as a multiset (two identical inserts need two matches). */
function matchInserts(a: Ins[], b: Ins[]): { aMatched: boolean[]; bMatched: boolean[] } {
  const bMatched = b.map(() => false)
  const aMatched = a.map((x) => {
    const k = b.findIndex((y, i) => !bMatched[i] && y.l.text === x.l.text)
    if (k >= 0) bMatched[k] = true
    return k >= 0
  })
  return { aMatched, bMatched }
}

function gapRow(gap: Gap, where: GapRow['where'], header: string): GapRow {
  return { type: 'gap', key: `gap:${gap.key}`, gap, fn: fnLabel(header), where }
}

/** Rows in base order — insertions before each base line first (side by side,
 *  padded), then the base line with its state in each column — with a gap row
 *  between covered segments. `opts.trailing` as in `buildFileRows`: false for a
 *  wholly-new file, which has nothing below its last row. */
export function buildMultiRows(mids: Hunk[][], now: Hunk[], lang: string | null, opts: { trailing?: boolean } = {}): ViewRow[] {
  const ims = mids.map(indexSide), inow = indexSide(now)
  const near = ims.length - 1
  const gaps = multiGaps(mids, now)
  const gapByBase = new Map(gaps.map((g) => [g.from - g.oldOffset, g]))
  const bases = coveredBases([...ims, inow])
  const out: ViewRow[] = []

  const insertRows = (base: number): void => {
    const mi = ims.map((im) => im.insBefore.get(base) ?? []), ni = inow.insBefore.get(base) ?? []
    const depth = Math.max(ni.length, ...mi.map((m) => m.length))
    if (depth === 0) return
    // current against the nearest checkpoint; every checkpoint against current
    const nowMatched = near >= 0 ? matchInserts(ni, mi[near]).aMatched : ni.map(() => false)
    const midMatched = mi.map((m) => matchInserts(m, ni).aMatched)
    for (let p = 0; p < depth; p++) {
      const n = ni[p]
      const midCells: Cell[] = mi.map((m, k) => {
        const x = m[p]
        return x
          ? { l: x.l, side: 'mid', lineNo: x.l.new, kind: 'add', html: html(x.l, lang), attribution: midMatched[k][p] ? undefined : 'gone' }
          : pad('mid')
      })
      const nowCell: Cell = n
        ? { l: n.l, side: 'new', lineNo: n.l.new, kind: 'add', html: html(n.l, lang), attribution: nowMatched[p] ? undefined : 'since' }
        : pad('new')
      // the nearest checkpoint's and current's own words, where they sit side by side and differ
      const m = near >= 0 ? mi[near][p] : undefined
      if (m && n && !nowMatched[p]) {
        const r = wordDiffRanges(disp(m.l.text), disp(n.l.text))
        if (r.old.length) midCells[near].marks = r.old
        if (r.new.length) nowCell.marks = r.new
      }
      const firstMid = mi.findIndex((x) => x[p] != null)
      out.push({
        type: 'aligned',
        key: n ? `new:${n.l.new}` : `mid${firstMid}:${mi[firstMid][p].l.new}`,
        cells: [pad('old'), ...midCells, nowCell],
        anchor: n ? { side: 'new', lineNo: n.l.new! } : null,
        hunkRange: n ? n.hunk.range : '',
        fromHunk: n != null,
        run: n ? { lines: n.hunk.lines, idx: n.idx } : null
      })
    }
  }

  for (let i = 0; i < bases.length; i++) {
    const b = bases[i]
    if (i === 0 || b !== bases[i - 1] + 1) {
      const g = gapByBase.get(i === 0 ? 1 : bases[i - 1] + 1)
      if (g && g.to != null) out.push(gapRow(g, i === 0 ? 'above' : '', (inow.hunkOf.get(b) ?? ims.find((im) => im.hunkOf.has(b))?.hunkOf.get(b))?.header ?? ''))
    }
    insertRows(b)
    const at = inow.lineAt.get(b) ?? ims.map((im) => im.lineAt.get(b)).find((x) => x != null)
    if (!at) continue // only the EOF insertion anchor lives here — no base line of its own
    const text = at.l.text
    const nowDel = inow.del.has(b)
    const nearDel = near >= 0 && ims[near].del.has(b)
    const nowNo = nowDel ? null : inow.kept.get(b) ?? b + offsetAt(inow, b)
    const nowAt = inow.lineAt.get(b)
    const baseCell: Cell = { l: at.l, side: 'old', lineNo: b, kind: nowDel ? 'del' : '', html: html(at.l, lang) }
    const midCells: Cell[] = ims.map((im) => {
      if (im.del.has(b)) return { l: null, side: 'mid', lineNo: null, kind: '', deleted: true, attribution: nowDel ? undefined : 'gone' }
      const no = im.kept.get(b) ?? b + offsetAt(im, b)
      const l = im.lineAt.get(b)?.l ?? { old: b, new: no, kind: '' as const, text }
      return { l, side: 'mid', lineNo: no, kind: '', html: html(l, lang) }
    })
    const nowCell: Cell = nowDel
      ? { l: null, side: 'new', lineNo: null, kind: '', deleted: true, attribution: nearDel ? undefined : 'since' }
      : (() => { const l = nowAt?.l ?? { old: b, new: nowNo, kind: '' as const, text }; return { l, side: 'new' as const, lineNo: nowNo, kind: '' as const, html: html(l, lang) } })()
    out.push({
      type: 'aligned', key: `old:${b}`,
      cells: [baseCell, ...midCells, nowCell],
      // commentable only where git's current-diff has the line: that is the anchor
      // payload (hunkRange) the re-anchor pipeline expects
      anchor: nowAt ? (nowDel ? { side: 'old', lineNo: b } : { side: 'new', lineNo: nowNo! }) : null,
      hunkRange: nowAt?.hunk.range ?? '',
      fromHunk: nowAt != null,
      run: nowAt ? { lines: nowAt.hunk.lines, idx: nowAt.idx } : null
    })
  }
  const tail = gaps[gaps.length - 1]
  if (opts.trailing !== false && bases.length) out.push(gapRow(tail, 'below', ''))
  return out
}
