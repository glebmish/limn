import type { DiffLine, Hunk } from '../../shared/types'

/** A run of unchanged file lines the diff does not show, in new-side (working-tree)
 *  line numbers. `to: null` means "to end of file" — the file length is unknown
 *  until the working file is fetched. `old = new - oldOffset` inside the gap. */
export interface Gap {
  key: string
  from: number
  to: number | null
  oldOffset: number
  /** Multi only: the checkpoint column's number for a line in this run is
   *  `new - midOffset` (the run is unchanged in every column, so one offset does). */
  midOffset?: number
}

function bounds(h: Hunk): { newStart: number; newEnd: number; oldStart: number; oldEnd: number } {
  let newStart = 0, newEnd = 0, oldStart = 0, oldEnd = 0
  for (const l of h.lines) {
    if (l.new != null) { if (!newStart) newStart = l.new; newEnd = l.new }
    if (l.old != null) { if (!oldStart) oldStart = l.old; oldEnd = l.old }
  }
  return { newStart, newEnd, oldStart, oldEnd }
}

/** New-side gaps around/between hunks: before the first, between neighbours, and a
 *  trailing to-EOF gap. Assumes hunks are in file order (git emits them that way). */
export function hunkGaps(hunks: Hunk[]): Gap[] {
  const gaps: Gap[] = []
  let cursor = 1
  let oldOffset = 0
  for (const h of hunks) {
    const b = bounds(h)
    if (b.newStart > cursor) {
      // offset before a hunk = the hunk's own start alignment
      gaps.push({ key: `g${cursor}`, from: cursor, to: b.newStart - 1, oldOffset: b.newStart - b.oldStart })
    }
    cursor = b.newEnd + 1
    oldOffset = b.newEnd - b.oldEnd
  }
  gaps.push({ key: `g${cursor}`, from: cursor, to: null, oldOffset })
  return gaps
}

/** Materialize a gap as plain context DiffLines from the fetched working file. */
export function gapLines(fileLines: string[], gap: Gap): DiffLine[] {
  const to = Math.min(gap.to ?? fileLines.length, fileLines.length)
  const rows: DiffLine[] = []
  for (let n = gap.from; n <= to; n++) {
    rows.push({ old: n - gap.oldOffset, new: n, kind: '', text: fileLines[n - 1] })
  }
  return rows
}

// ── stepped folds (GitHub's): STEP lines from either edge at a time ────────────

export const STEP = 20
/** Lines revealed from each edge of a collapsed run. */
export interface GapReveal { top: number; bottom: number }

const NONE: GapReveal = { top: 0, bottom: 0 }

function gapEnd(gap: Gap, total: number | null): number | null {
  return gap.to ?? total
}

/** The still-hidden span of a run, in new-side numbers; null once it is all shown.
 *  An unbounded tail with no known length is "hidden from `from + top` onward". */
export function hiddenRange(gap: Gap, reveal: GapReveal, total: number | null): { from: number; to: number | null } | null {
  const end = gapEnd(gap, total)
  const from = gap.from + reveal.top
  if (end == null) return { from, to: null }
  const to = end - reveal.bottom
  return from <= to ? { from, to } : null
}

/** What the fold row offers: two step buttons (up = toward the change below the
 *  run, down = toward the change above it) while more than STEP lines hide, one
 *  "expand N" once STEP or fewer remain, nothing once the run is fully shown. The
 *  leading run has no change above it to step down from; the trailing run none
 *  below to step up from. */
export function foldControls(gap: Gap, reveal: GapReveal, total: number | null, where: 'above' | 'below' | ''):
  { kind: 'single'; count: number } | { kind: 'steps'; up: boolean; down: boolean; count: number | null } | null {
  const h = hiddenRange(gap, reveal, total)
  if (!h) return null
  const count = h.to == null ? null : h.to - h.from + 1
  if (count != null && count <= STEP) return { kind: 'single', count }
  return { kind: 'steps', up: where !== 'below', down: where !== 'above', count }
}

/** `n` more lines from `edge`, never past what the other edge already shows. */
export function stepReveal(gap: Gap, reveal: GapReveal, edge: 'top' | 'bottom', total: number | null, n = STEP): GapReveal {
  const end = gapEnd(gap, total)
  const size = end == null ? Infinity : end - gap.from + 1
  const room = Math.max(0, size - reveal.top - reveal.bottom)
  const take = Math.min(n, room)
  if (!Number.isFinite(take)) return reveal
  return edge === 'top' ? { top: reveal.top + take, bottom: reveal.bottom } : { top: reveal.top, bottom: reveal.bottom + take }
}

/** The revealed edges of a run as plain context lines, from the fetched file. */
export function revealLines(fileLines: string[], gap: Gap, reveal: GapReveal): { top: DiffLine[]; bottom: DiffLine[] } {
  const end = Math.min(gap.to ?? fileLines.length, fileLines.length)
  const line = (n: number): DiffLine => ({ old: n - gap.oldOffset, new: n, kind: '', text: fileLines[n - 1] })
  const top: DiffLine[] = []
  for (let n = gap.from; n < gap.from + reveal.top && n <= end; n++) top.push(line(n))
  const bottom: DiffLine[] = []
  const bottomStart = Math.max(end - reveal.bottom + 1, gap.from + reveal.top)
  for (let n = bottomStart; n <= end; n++) bottom.push(line(n))
  return { top, bottom }
}

/** The fold still hiding new-side line `line`, with the edge a reveal should come
 *  from: the top edge when the line is nearer the run's top, else the bottom. */
export function gapContaining(gaps: Gap[], reveals: Record<string, GapReveal>, total: number | null, line: number):
  { gap: Gap; edge: 'top' | 'bottom' } | undefined {
  for (const gap of gaps) {
    const h = hiddenRange(gap, reveals[gap.key] ?? NONE, total)
    if (!h || line < h.from || (h.to != null && line > h.to)) continue
    if (h.to == null) return { gap, edge: 'top' }
    return { gap, edge: line - h.from <= h.to - line ? 'top' : 'bottom' }
  }
  return undefined
}
