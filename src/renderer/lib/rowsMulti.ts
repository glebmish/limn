import type { DiffLine, Hunk } from '../../shared/types'
import type { Gap } from './expand'
import { discardSpansForRun, type DiscardSpan } from './edits'
import { fnLabel, runHighlight, type Cell, type GapRow, type ViewRow } from './rows'
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

/** One column's lines highlighted the way `linesForRun` does it: one `runHighlight`
 *  pass per hunk, both sides, so a construct spanning several of the hunk's lines (a
 *  block comment, a template literal — #7) keeps its styling on every line it covers.
 *  Indexed by the `DiffLine` identity the row builder already carries, since a cell
 *  reaches its line through `lineAt`/`insBefore` rather than by walking the run.
 *  The old and new passes are kept apart: the base column shows the file as it read
 *  before the run's changes, every other column as it reads after. */
function runHtml(hunks: Hunk[], lang: string | null): Map<DiffLine, { old?: string; new?: string }> {
  const out = new Map<DiffLine, { old?: string; new?: string }>()
  for (const h of hunks) {
    const hl = runHighlight(h.lines, lang)
    let oi = -1, ni = -1
    for (const l of h.lines) {
      const e: { old?: string; new?: string } = {}
      if (l.old != null) e.old = hl.old[++oi]
      if (l.new != null) e.new = hl.new[++ni]
      out.set(l, e)
    }
  }
  return out
}

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
 *  wholly-new file, which has nothing below its last row.
 *
 *  `gaps` come from `multiGaps(mids, now)` and are passed in, the same shape as
 *  `buildFileRows`/`buildSplitRows`: the caller already holds that array as the key
 *  space its reveals live in, so recomputing it here would put two structurally
 *  identical `Gap[]`s in play whose only guarantee of agreement is that both were
 *  built from the same input. */
export function buildMultiRows(mids: Hunk[][], now: Hunk[], gaps: Gap[], lang: string | null, opts: { trailing?: boolean } = {}): ViewRow[] {
  const ims = mids.map(indexSide), inow = indexSide(now)
  const near = ims.length - 1
  /** run-level HTML per column, indexed as `NOW_COL` / `midCol(k)` below. */
  const htmls = [runHtml(now, lang), ...mids.map((m) => runHtml(m, lang))]
  const NOW_COL = 0
  /** checkpoint `k`'s column index into `htmls` (current sits at 0). */
  const midCol = (k: number): number => k + 1
  /** `l`'s run-level HTML on `side`, tokenized in COLUMN `col`'s own run. The column
   *  is passed in rather than found by scanning, because the same `DiffLine` object
   *  can sit in two columns' hunks: a scan would hand both cells whichever column it
   *  hit first, so a line swallowed by a comment in one column would render that way
   *  in the other too. A line that column's hunks never show — the placeholder a
   *  column gets for a base line its own diff never touched — has no run to sit in,
   *  so the isolated-line highlighter is the honest answer there. */
  const html = (l: DiffLine, side: 'old' | 'new', col: number): string =>
    htmls[col].get(l)?.[side] ?? highlightLine(disp(l.text), lang)
  /** the current-diff hunk's discard spans, resolved once per hunk (rows.ts does the
   *  same per run) — only current's own hunks carry uncommitted lines */
  const spanCache = new Map<Hunk, readonly (DiscardSpan | null)[]>()
  const discardSpans = (h: Hunk): readonly (DiscardSpan | null)[] => {
    let s = spanCache.get(h)
    if (!s) { s = discardSpansForRun(h.lines); spanCache.set(h, s) }
    return s
  }
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
          ? { l: x.l, side: 'mid', lineNo: x.l.new, kind: 'add', html: html(x.l, 'new', midCol(k)), attribution: midMatched[k][p] ? undefined : 'gone' }
          : pad('mid')
      })
      const nowCell: Cell = n
        ? { l: n.l, side: 'new', lineNo: n.l.new, kind: 'add', html: html(n.l, 'new', NOW_COL), attribution: nowMatched[p] ? undefined : 'since' }
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
        run: n ? { lines: n.hunk.lines, idx: n.idx } : null,
        discard: n ? discardSpans(n.hunk)[n.idx] ?? null : null
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
    // the base line comes from current's diff where it has it, else from the first
    // checkpoint that does — and `atCol` records WHICH, so the base cell reads that
    // column's own run rather than whichever column happens to hold the same object
    const firstMidAt = ims.findIndex((im) => im.lineAt.has(b))
    const at = inow.lineAt.get(b) ?? (firstMidAt >= 0 ? ims[firstMidAt].lineAt.get(b) : undefined)
    if (!at) continue // only the EOF insertion anchor lives here — no base line of its own
    const atCol = inow.lineAt.has(b) ? NOW_COL : midCol(firstMidAt)
    const text = at.l.text
    const nowDel = inow.del.has(b)
    const nearDel = near >= 0 && ims[near].del.has(b)
    const nowNo = nowDel ? null : inow.kept.get(b) ?? b + offsetAt(inow, b)
    const nowAt = inow.lineAt.get(b)
    const baseCell: Cell = { l: at.l, side: 'old', lineNo: b, kind: nowDel ? 'del' : '', html: html(at.l, 'old', atCol) }
    // A checkpoint's empty slot is never `gone` ("the checkpoint had this — current
    // does not"): the checkpoint is precisely the column that does NOT have the line.
    // Where current kept a base line the nearest checkpoint dropped, that is the
    // documented `since` case — "a current line the checkpoint beside it never had" —
    // and the mark goes on the current cell, which is the one that has the line.
    const midCells: Cell[] = ims.map((im, k) => {
      if (im.del.has(b)) return { l: null, side: 'mid', lineNo: null, kind: '', deleted: true }
      const no = im.kept.get(b) ?? b + offsetAt(im, b)
      const l = im.lineAt.get(b)?.l ?? { old: b, new: no, kind: '' as const, text }
      return { l, side: 'mid', lineNo: no, kind: '', html: html(l, 'new', midCol(k)) }
    })
    const nowCell: Cell = nowDel
      ? { l: null, side: 'new', lineNo: null, kind: '', deleted: true, attribution: nearDel ? undefined : 'since' }
      : (() => {
          const l = nowAt?.l ?? { old: b, new: nowNo, kind: '' as const, text }
          return { l, side: 'new' as const, lineNo: nowNo, kind: '' as const, html: html(l, 'new', NOW_COL), attribution: nearDel ? ('since' as const) : undefined }
        })()
    out.push({
      type: 'aligned', key: `old:${b}`,
      cells: [baseCell, ...midCells, nowCell],
      // commentable only where git's current-diff has the line: that is the anchor
      // payload (hunkRange) the re-anchor pipeline expects
      anchor: nowAt ? (nowDel ? { side: 'old', lineNo: b } : { side: 'new', lineNo: nowNo! }) : null,
      hunkRange: nowAt?.hunk.range ?? '',
      fromHunk: nowAt != null,
      run: nowAt ? { lines: nowAt.hunk.lines, idx: nowAt.idx } : null,
      discard: nowAt ? discardSpans(nowAt.hunk)[nowAt.idx] ?? null : null
    })
  }
  // The trailing run to EOF, under `buildFileRows`'s rule: a file with no new side at
  // all has nothing below its last row, and asserting a run of hidden lines under it
  // is a plain lie the reader can't disprove. "No new side" is a statement about
  // CURRENT only — a file current's own diff does not touch at all (only a checkpoint
  // differs from base) plainly continues below, so an empty `now` keeps its tail.
  const nowShowsALine = now.length === 0 || now.some((h) => h.lines.some((l) => l.new != null))
  const tail = gaps[gaps.length - 1]
  if (tail && opts.trailing !== false && bases.length && nowShowsALine) out.push(gapRow(tail, 'below', ''))
  return out
}
