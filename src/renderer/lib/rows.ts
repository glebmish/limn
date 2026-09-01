import type { DiffLine, Hunk } from '../../shared/types'
import { disp } from './highlight'
import type { Gap } from './expand'
import { pairHunkLines, wordDiffRanges, type CharRange } from './worddiff'

/** The file body's row model (#11). git hands us *hunks*; the reader wants the
 *  *file*. This module translates at the renderer boundary — the server-side hunk
 *  model is untouched — flattening a file's hunks and the collapsed runs between
 *  them into one continuous, file-line-keyed row list. Nothing about `@@` survives
 *  the translation: a hunk's `range` rides along only because the comment anchor
 *  payload still carries it (`Anchor.hunkRange`, which the server's re-anchor
 *  pipeline writes), and its `header` is reduced to a plain function name for the
 *  collapsed-run label. */

/** A row's identity within a file: the file line it shows, on the side it shows it.
 *  Working-tree rows (context and `+`) key on the new side, deletions — which have
 *  no new-side line — key on the old side. The two never collide (a `new:` key and
 *  an `old:` key are different strings), and within a side the numbers are unique
 *  because a file's hunks cover disjoint, ordered line ranges. This is exactly the
 *  `side:line` half of the `data-limn-line` attribute the focus/anchor machinery
 *  already jumps by, so one scheme now serves React keys, the comment composer's
 *  position, and DOM addressing alike. */
export function rowKey(l: DiffLine): string {
  return l.new != null ? `new:${l.new}` : `old:${l.old}`
}

export interface LineRow {
  type: 'line'
  key: string
  side: 'new' | 'old'
  lineNo: number
  l: DiffLine
  /** The git hunk range this row came from — carried for the comment anchor's
   *  `hunkRange` field ONLY. Never rendered (#11). Empty for a revealed context row,
   *  which belongs to no hunk. */
  hunkRange: string
  /** False for a row revealed out of a collapsed run. Such a row is real file
   *  content but not part of the diff, so it carries no comment affordance and hosts
   *  no thread — by construction no rendered anchor points at it. */
  fromHunk: boolean
  /** word-diff marks for this row, absent when it has none */
  marks?: CharRange[]
  /** The contiguous run of DiffLines this row sits in (one hunk's lines, or one
   *  revealed gap's lines) with this row's index in it — what `discardSpanAt` walks
   *  and what the frame-sliver test looks either side of. Runs stop at the run
   *  boundary on purpose: a collapsed gap between two hunks is real file content, so
   *  an unstaged span must never be treated as continuing across it. */
  run: DiffLine[]
  runIdx: number
}

export interface GapRow {
  type: 'gap'
  key: string
  gap: Gap
  /** the function the collapsed run leads into, from the following hunk's git
   *  context — '' when there is none (the trailing run, or an unparseable header) */
  fn: string
  /** 'above' for the run before the first change, 'below' for the trailing run to
   *  EOF, '' for a run between two changes */
  where: 'above' | 'below' | ''
}

export type FileRow = LineRow | GapRow

/** Control-flow words git's default funcname pattern happily picks as "context".
 *  Naming a collapsed run "in if" is worse than not labelling it. */
const CTRL = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'catch', 'try', 'with',
  'return', 'function', 'fn', 'def', 'sub', 'match', 'when', 'elif', 'until'
])

/** A plain function/type name out of a git hunk header's context text
 *  (`@@ … @@ export function updateSessionMeta(…` → `updateSessionMeta`). The `@@`
 *  syntax is gone from the UI; this is the genuinely useful part of it, kept. */
export function fnLabel(header: string): string {
  const h = header.trim()
  if (!h) return ''
  for (const m of h.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) {
    if (!CTRL.has(m[1])) return m[1]
  }
  const decl = h.match(/\b(?:class|interface|struct|enum|trait|impl|namespace|module|type)\s+([A-Za-z_$][\w$]*)/)
  return decl ? decl[1] : ''
}

/** GitHub-style intra-line marks for one run's del/add pairs, by index in the run. */
function runWordMarks(lines: DiffLine[]): Map<number, CharRange[]> {
  const marks = new Map<number, CharRange[]>()
  for (const [d, a] of pairHunkLines(lines)) {
    const r = wordDiffRanges(disp(lines[d].text), disp(lines[a].text))
    if (r.old.length) marks.set(d, r.old)
    if (r.new.length) marks.set(a, r.new)
  }
  return marks
}

/** One LineRow for `run[idx]`. Exported so DiffBody can build rows for a gap the
 *  reader just expanded — those lines arrive from the working tree at render time,
 *  long after the model was built, and must land in the same key space. */
export function lineRow(
  run: DiffLine[], idx: number, opts: { hunkRange: string; fromHunk: boolean; marks?: CharRange[] }
): LineRow {
  const l = run[idx]
  const side: 'new' | 'old' = l.new != null ? 'new' : 'old'
  return {
    type: 'line', key: rowKey(l), side, lineNo: (l.new ?? l.old)!, l,
    hunkRange: opts.hunkRange, fromHunk: opts.fromHunk, marks: opts.marks, run, runIdx: idx
  }
}

/** The file's rows in file order: each collapsed run (from `hunkGaps`) as one gap
 *  row, each hunk's lines as plain line rows, with no hunk boundary of any kind
 *  between them. Pass `gaps: []` where expand-context is unavailable (a read-only
 *  review) and the result is line rows only.
 *
 *  The result is ONE flat array for the whole file, which is the point: React
 *  reconciles the body as a single key-matched list, so an edit frame growing from
 *  one hunk into the next — or out of a hunk into a revealed run — is a key match
 *  rather than a remount (see `FrameDraft` in lib/edits.ts for what that used to
 *  cost). */
export function buildFileRows(hunks: Hunk[], gaps: Gap[]): FileRow[] {
  const rows: FileRow[] = []
  const byFrom = new Map(gaps.map((g) => [g.from, g]))
  let cursor = 1
  hunks.forEach((h, i) => {
    const g = byFrom.get(cursor)
    // a bounded run before this hunk; `hunkGaps` emits one only where there is
    // hidden content, and the sole unbounded gap is the trailing one
    if (g && g.to != null && g.to >= g.from) {
      rows.push({ type: 'gap', key: `gap:${g.key}`, gap: g, fn: fnLabel(h.header), where: i === 0 ? 'above' : '' })
    }
    const marks = runWordMarks(h.lines)
    h.lines.forEach((_l, j) => rows.push(lineRow(h.lines, j, { hunkRange: h.range, fromHunk: true, marks: marks.get(j) })))
    let end = 0
    for (const l of h.lines) if (l.new != null) end = l.new
    cursor = end + 1
  })
  // the trailing run to EOF — its length is unknown until the working file is read,
  // so it is offered even when the last hunk already reaches the end (expanding it
  // then reveals nothing and the fold stays closed)
  const tail = hunks.length > 0 ? byFrom.get(cursor) : undefined
  if (tail && tail.to == null) rows.push({ type: 'gap', key: `gap:${tail.key}`, gap: tail, fn: '', where: 'below' })
  return rows
}
