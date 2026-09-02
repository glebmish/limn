import type { DiffLine, Hunk } from '../../shared/types'
import type { Gap } from './expand'
import { fnLabel, type Cell, type GapRow, type ViewRow } from './rows'
import { disp, highlightLine } from './highlight'
import { wordDiffRanges } from './worddiff'

/** The Multi layout's row builder: Base · Checkpoint · Now, both side columns
 *  diffed against base (two base-relative hunk sets, both straight from git), rows
 *  aligned on base line numbers, and each divergence between the two side columns
 *  attributed — `since` on a now line the checkpoint never had, `gone` on a
 *  checkpoint line the tree no longer has. No cross-column diff is computed here:
 *  attribution is a text match at the same base position, nothing more. */

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

function coveredBases(im: SideIndex, inow: SideIndex): number[] {
  return [...new Set([...im.covered, ...inow.covered])].sort((a, b) => a - b)
}

/** Collapsed runs in NOW coordinates with offsets back to base (`oldOffset`) and to
 *  the checkpoint (`midOffset`), between the segments either side touched. A run is
 *  unchanged in every column, so one text fetch (the tree now) fills it. */
export function multiGaps(mid: Hunk[], now: Hunk[]): Gap[] {
  const im = indexSide(mid), inow = indexSide(now)
  const bases = coveredBases(im, inow)
  const gapFor = (baseFrom: number, baseTo: number | null): Gap => {
    const dNow = offsetAt(inow, baseFrom - 1), dMid = offsetAt(im, baseFrom - 1)
    const from = baseFrom + dNow
    return { key: `g${from}`, from, to: baseTo == null ? null : baseTo + dNow, oldOffset: dNow, midOffset: dNow - dMid }
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

/** Which checkpoint insertions a now insertion at the same base position repeats,
 *  matched by text as a multiset (two identical inserts need two matches). */
function matchInserts(mi: Ins[], ni: Ins[]): { nowMatched: boolean[]; midMatched: boolean[] } {
  const midMatched = mi.map(() => false)
  const nowMatched = ni.map((n) => {
    const k = mi.findIndex((m, i) => !midMatched[i] && m.l.text === n.l.text)
    if (k >= 0) midMatched[k] = true
    return k >= 0
  })
  return { nowMatched, midMatched }
}

function gapRow(gap: Gap, where: GapRow['where'], header: string): GapRow {
  return { type: 'gap', key: `gap:${gap.key}`, gap, fn: fnLabel(header), where }
}

/** Rows in base order — insertions before each base line first (side by side,
 *  padded), then the base line with its state in each column — with a gap row
 *  between covered segments. `opts.trailing` as in `buildFileRows`: false for a
 *  wholly-new file, which has nothing below its last row. */
export function buildMultiRows(mid: Hunk[], now: Hunk[], lang: string | null, opts: { trailing?: boolean } = {}): ViewRow[] {
  const im = indexSide(mid), inow = indexSide(now)
  const gaps = multiGaps(mid, now)
  const gapByBase = new Map(gaps.map((g) => [g.from - g.oldOffset, g]))
  const bases = coveredBases(im, inow)
  const out: ViewRow[] = []

  const insertRows = (base: number): void => {
    const mi = im.insBefore.get(base) ?? [], ni = inow.insBefore.get(base) ?? []
    if (!mi.length && !ni.length) return
    const { nowMatched, midMatched } = matchInserts(mi, ni)
    for (let p = 0; p < Math.max(mi.length, ni.length); p++) {
      const m = mi[p], n = ni[p]
      const midCell: Cell = m
        ? { l: m.l, side: 'mid', lineNo: m.l.new, kind: 'add', html: html(m.l, lang), attribution: midMatched[p] ? undefined : 'gone' }
        : pad('mid')
      const nowCell: Cell = n
        ? { l: n.l, side: 'new', lineNo: n.l.new, kind: 'add', html: html(n.l, lang), attribution: nowMatched[p] ? undefined : 'since' }
        : pad('new')
      // the two columns' own words, where they sit side by side and differ
      if (m && n && !nowMatched[p]) {
        const r = wordDiffRanges(disp(m.l.text), disp(n.l.text))
        if (r.old.length) midCell.marks = r.old
        if (r.new.length) nowCell.marks = r.new
      }
      out.push({
        type: 'aligned',
        key: n ? `new:${n.l.new}` : `mid:${m.l.new}`,
        cells: [pad('old'), midCell, nowCell],
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
      if (g && g.to != null) out.push(gapRow(g, i === 0 ? 'above' : '', (inow.hunkOf.get(b) ?? im.hunkOf.get(b))?.header ?? ''))
    }
    insertRows(b)
    const at = inow.lineAt.get(b) ?? im.lineAt.get(b)
    if (!at) continue // only the EOF insertion anchor lives here — no base line of its own
    const text = at.l.text
    const midDel = im.del.has(b), nowDel = inow.del.has(b)
    const midNo = midDel ? null : im.kept.get(b) ?? b + offsetAt(im, b)
    const nowNo = nowDel ? null : inow.kept.get(b) ?? b + offsetAt(inow, b)
    const nowAt = inow.lineAt.get(b)
    const midAt = im.lineAt.get(b)
    const baseCell: Cell = { l: at.l, side: 'old', lineNo: b, kind: nowDel ? 'del' : '', html: html(at.l, lang) }
    const midCell: Cell = midDel
      ? { l: null, side: 'mid', lineNo: null, kind: '', deleted: true, attribution: nowDel ? undefined : 'gone' }
      : (() => { const l = midAt?.l ?? { old: b, new: midNo, kind: '' as const, text }; return { l, side: 'mid' as const, lineNo: midNo, kind: '' as const, html: html(l, lang) } })()
    const nowCell: Cell = nowDel
      ? { l: null, side: 'new', lineNo: null, kind: '', deleted: true, attribution: midDel ? undefined : 'since' }
      : (() => { const l = nowAt?.l ?? { old: b, new: nowNo, kind: '' as const, text }; return { l, side: 'new' as const, lineNo: nowNo, kind: '' as const, html: html(l, lang) } })()
    out.push({
      type: 'aligned', key: `old:${b}`,
      cells: [baseCell, midCell, nowCell],
      // commentable only where git's now-diff has the line: that is the anchor
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
