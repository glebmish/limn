import type { DiffLine, Hunk } from '../../shared/types'
import { disp, highlightRun } from './highlight'
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
 *  position, and DOM addressing alike.
 *
 *  Null for a line with neither side — which `parseUnifiedDiff` does not produce
 *  today, but a keyless row is exactly the case that must NOT be papered over with a
 *  non-null assertion: it would key `old:undefined` and emit a `data-limn-line`
 *  target that the focus/anchor machinery could resolve to the wrong row. Callers
 *  drop such a row instead. */
export function rowKey(l: DiffLine): string | null {
  if (l.new != null) return `new:${l.new}`
  if (l.old != null) return `old:${l.old}`
  return null
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
  /** Cross-line-aware syntax-highlighted HTML for this row's text (#7), computed
   *  once per run by `linesForRun` — not per row per render. Set for every row that
   *  goes through `linesForRun` (escaped plain text when the file has no language,
   *  same as the per-line highlighter would produce); optional only so a `LineRow`
   *  built by hand (tests) doesn't have to supply it, in which case `CodeLine` falls
   *  back to its own per-line highlighter. */
  html?: string
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

/** Control-flow and declaration words git's default funcname pattern happily picks as
 *  "context". Naming a collapsed run "in if" is worse than not labelling it — and so
 *  is "in func", which is what a Go method (`func (s *S) Method(`, where the receiver
 *  parenthesis follows the keyword directly) yields without `func` listed here. */
const CTRL = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'catch', 'try', 'with',
  'return', 'function', 'fn', 'func', 'def', 'lambda', 'sub', 'match', 'when',
  'elif', 'until'
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

/** Two hljs passes over one contiguous run — old-side text (context + del: the file
 *  as it read before this run's changes) and new-side text (context + add: the file
 *  as it reads now) — each joined and tokenized as a single block (`highlightRun`,
 *  lib/highlight.ts) so a construct spanning several of the run's own lines (a block
 *  comment, a template literal — #7) keeps its styling on every line it covers, then
 *  split back to one HTML string per line on that side.
 *
 *  Scoped to the run's own visible lines, not the whole file: a collapsed gap
 *  before/after a run is real hidden content that could carry token state into this
 *  run's first/last line, and neither side has its full text available up front
 *  here — the new side is only fetched, lazily, once a fold is opened (`fileLinesRef`
 *  in DiffBody), and the old side is never fetched by this component at all. Treating
 *  each visible run as its own tokenizer start is the deliberate, documented
 *  compromise, not an oversight. */
export function runHighlight(run: DiffLine[], lang: string | null): { old: string[]; new: string[] } {
  const oldLines = run.filter((l) => l.old != null).map((l) => disp(l.text))
  const newLines = run.filter((l) => l.new != null).map((l) => disp(l.text))
  return { old: highlightRun(oldLines, lang), new: highlightRun(newLines, lang) }
}

/** One run's line rows, each carrying its precomputed `html` (`runHighlight` above)
 *  alongside whatever word-marks it has — the join point between the row model and
 *  cross-line highlighting. A context row's `html` comes from the new-side pass (its
 *  `side` is always `'new'`, see `lineRow`); a deletion's from the old-side pass.
 *
 *  Replaces a bare `run.forEach(lineRow)` loop so both call sites — a hunk's own
 *  lines in `buildFileRows`, a revealed gap's lines in `DiffBody` — get the same
 *  treatment, and so the whole-run highlight pass happens once per run rather than
 *  once per row. */
export function linesForRun(
  run: DiffLine[], lang: string | null,
  opts: { hunkRange: string; fromHunk: boolean; marks?: Map<number, CharRange[]> }
): LineRow[] {
  const html = runHighlight(run, lang)
  const out: LineRow[] = []
  let oldIdx = -1
  let newIdx = -1
  run.forEach((l, j) => {
    if (l.old != null) oldIdx++
    if (l.new != null) newIdx++
    const row = lineRow(run, j, { hunkRange: opts.hunkRange, fromHunk: opts.fromHunk, marks: opts.marks?.get(j) })
    if (!row) return
    row.html = row.side === 'new' ? html.new[newIdx] : html.old[oldIdx]
    out.push(row)
  })
  return out
}

/** One LineRow for `run[idx]`, or null when the line has no side to address it by
 *  (see `rowKey`) — an unaddressable row is dropped rather than rendered under a
 *  fabricated key. Exported so DiffBody can build rows for a gap the reader just
 *  expanded: those lines arrive from the working tree at render time, long after the
 *  model was built, and must land in the same key space. */
export function lineRow(
  run: DiffLine[], idx: number, opts: { hunkRange: string; fromHunk: boolean; marks?: CharRange[] }
): LineRow | null {
  const l = run[idx]
  const key = rowKey(l)
  if (key == null) return null
  const side: 'new' | 'old' = l.new != null ? 'new' : 'old'
  return {
    type: 'line', key, side, lineNo: (l.new ?? l.old) as number, l,
    hunkRange: opts.hunkRange, fromHunk: opts.fromHunk, marks: opts.marks, run, runIdx: idx
  }
}

/** The file's rows in file order: each collapsed run (from `hunkGaps`) as one gap
 *  row, each hunk's lines as plain line rows, with no hunk boundary of any kind
 *  between them.
 *
 *  Gap rows are built from `hunkGaps` unconditionally — the caller decides whether
 *  each one is *expandable* (that needs a worktree) or renders as an inert marker.
 *  They are never omitted: a `.dline` has no top border, so without them two hunks
 *  render as adjacent rows with the gutter silently jumping (12–16 straight into
 *  31–33), which is worse than the `@@` header this task removed.
 *
 *  The result is ONE flat array for the whole file, which is the point: React
 *  reconciles the body as a single key-matched list, so an edit frame growing from
 *  one hunk into the next — or out of a hunk into a revealed run — is a key match
 *  rather than a remount (see `FrameDraft` in lib/edits.ts for what that used to
 *  cost).
 *
 *  `lang` (an hljs language id, or null when the file has none) drives the
 *  cross-line-aware highlight pass (#7) attached to each row as `html`; it defaults
 *  to null so existing callers/tests that don't care about highlighting are
 *  unaffected.
 *
 *  `opts.trailing` is the caller's answer to "is there any file below the last shown
 *  row?" — false for a wholly-new file, whose single hunk *is* the file (an added
 *  file's `@@ -0,0 +1,N @@` covers every line there is). Defaults to true; the other
 *  no-tail case — a wholly-deleted file, where the new side is empty — is detected
 *  here, since it is visible in the hunks themselves. */
export function buildFileRows(
  hunks: Hunk[], gaps: Gap[], lang: string | null = null, opts: { trailing?: boolean } = {}
): FileRow[] {
  const rows: FileRow[] = []
  const byFrom = new Map(gaps.map((g) => [g.from, g]))
  let cursor = 1
  let anyNewSide = false
  hunks.forEach((h, i) => {
    const g = byFrom.get(cursor)
    // a bounded run before this hunk; `hunkGaps` emits one only where there is
    // hidden content, and the sole unbounded gap is the trailing one
    if (g && g.to != null && g.to >= g.from) {
      rows.push({ type: 'gap', key: `gap:${g.key}`, gap: g, fn: fnLabel(h.header), where: i === 0 ? 'above' : '' })
    }
    rows.push(...linesForRun(h.lines, lang, { hunkRange: h.range, fromHunk: true, marks: runWordMarks(h.lines) }))
    let end = 0
    for (const l of h.lines) if (l.new != null) end = l.new
    if (end > 0) anyNewSide = true
    cursor = end + 1
  })
  // The trailing run to EOF — its length is unknown until the working file is read, so
  // it is offered even when the last hunk already reaches the end (expanding it then
  // reveals nothing and the fold stays closed). But "unknown" is not "unbounded": on a
  // file with no new side at all (every line deleted — the cursor never left 1) or one
  // the caller tells us is wholly new, there IS no file below, and asserting a run of
  // hidden lines under it is a plain lie the reader can't disprove.
  const hasTail = opts.trailing !== false && anyNewSide
  const tail = hasTail ? byFrom.get(cursor) : undefined
  if (tail && tail.to == null) rows.push({ type: 'gap', key: `gap:${tail.key}`, gap: tail, fn: '', where: 'below' })
  return rows
}

/** The rows as they actually render: a revealed run replaces its collapsed-run row
 *  with plain context rows, in the same file-line key space as everything else.
 *
 *  `canExpand` gates BOTH halves, and that is the point rather than an optimization.
 *  `expandedGaps` is DiffBody's own state, keyed by the gap's `g<from>` — and `g1` is
 *  the leading gap's key in *every* diff mode, while the rows either side of it differ
 *  wildly between "Full diff" and "Since approved". Splicing branch-mode lines into a
 *  since-mode view produced duplicate React keys (or a silent hole in the file's line
 *  numbering) on a tab switch. Folds can only be *opened* in branch mode, so a
 *  revealed run that survives into any other mode is by definition stale and is
 *  ignored here; DiffBody additionally drops the state when the mode changes.
 *
 *  The trailing run's inert marker is dropped for the same "say only true things"
 *  reason as `buildFileRows`'s tail guard: it marks no discontinuity *between shown
 *  rows* (nothing follows it), and with no worktree to read, its length is unknowable
 *  — so it can only ever read "there is more file", forever. Where it can be opened
 *  (branch mode, writable) it stays exactly as it was. */
export function viewRows(
  rows: FileRow[], expandedGaps: Record<string, DiffLine[]>, canExpand: boolean, lang: string | null = null
): FileRow[] {
  const view: FileRow[] = []
  for (const r of rows) {
    if (r.type === 'gap') {
      const revealed = canExpand ? expandedGaps[r.gap.key] : undefined
      if (revealed?.length) {
        // same cross-line highlight treatment as a hunk's own lines (#7) — a revealed
        // run is real, contiguous file content and can itself contain a block comment
        // or template literal spanning its lines
        view.push(...linesForRun(revealed, lang, { hunkRange: '', fromHunk: false }))
        continue
      }
      if (!canExpand && r.where === 'below') continue
    }
    view.push(r)
  }
  return view
}
