import type { DiffLine, Hunk } from '../../shared/types'

/** A run of unchanged file lines the diff does not show, in new-side (working-tree)
 *  line numbers. `to: null` means "to end of file" — the file length is unknown
 *  until the working file is fetched. `old = new - oldOffset` inside the gap. */
export interface Gap { key: string; from: number; to: number | null; oldOffset: number }

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
