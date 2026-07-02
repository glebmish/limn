import fs from 'node:fs'
import nodePath from 'node:path'
import type { AnchorContext, Artifact, Comment, CommentAnchor, DiffSkeleton, FileDiff, SessionMeta } from '../shared/types.js'
import { blobShaAt, catBlob, diffContents, hashObjects, renameMap, showFile } from './git.js'
import { stampAnchor } from './anchorStamp.js'

// ── anchor v2: pure, git-free foundation ───────────────────────
// (stage-1 diff mapping + stage-2 fuzzy context match; the async pipeline that
// composes them into the three-stage re-anchor is at the bottom of this file.)

export const CONTEXT_N = 3
export const QUOTE_WEIGHT = 0.5
export const CONTEXT_WEIGHT = 0.35
export const PROXIMITY_WEIGHT = 0.15
export const ACCEPT_THRESHOLD = 0.75
export const BLANK_QUOTE_CTX_MIN = 0.8 // blank/whitespace quote must be carried by context
// Gentle proximity decay: proximity = 1 / (1 + distance·PROXIMITY_DECAY) — 1.0 at
// the hint, strictly decreasing as distance grows, asymptoting toward (but never
// reaching) 0. Exported (Q5: tuning must be a visible diff) since it materially
// affects acceptance at distance for non-blank quotes.
export const PROXIMITY_DECAY = 0.05

/** Trim, then collapse every internal run of whitespace to a single space.
 *  Makes similarity comparisons whitespace-insensitive. */
export function normalizeWs(s: string): string {
  return s.trim().replace(/\s+/g, ' ')
}

/** Character bigrams of `s` as a multiset (bigram -> count). Empty for
 *  strings shorter than 2 characters. */
function bigramCounts(s: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (let i = 0; i < s.length - 1; i++) {
    const bg = s.slice(i, i + 2)
    counts.set(bg, (counts.get(bg) ?? 0) + 1)
  }
  return counts
}

/** Sørensen–Dice coefficient over character bigrams, 0..1. Hand-rolled (no
 *  new dependency). Callers pass already-normalized strings — this function
 *  does not normalize. */
export function similarity(a: string, b: string): number {
  if (a === '' && b === '') return 1
  if (a === '' || b === '') return 0
  if (a.length === 1 || b.length === 1) return a === b ? 1 : 0

  const countsA = bigramCounts(a)
  const countsB = bigramCounts(b)
  let intersection = 0
  for (const [bg, count] of countsA) {
    const other = countsB.get(bg)
    if (other) intersection += Math.min(count, other)
  }
  const total = (a.length - 1) + (b.length - 1)
  return (2 * intersection) / total
}

/** The `-U0` edit list between an old and a new content (a later task adapts
 *  `parseUnifiedDiff` output into this shape). */
export interface EditHunk { oldStart: number; oldLen: number; newStart: number; newLen: number }

/** Stage-1 walker (spec §3 stage 1 step 5): deterministically map a 1-based
 *  line `L` in OLD-content space through ascending, non-overlapping `hunks`
 *  to its position in NEW-content space. Returns `'EDITED'` when `L` falls
 *  inside a real edited region (oldLen >= 1) — the caller falls back to
 *  stage 2. Pure insertions (oldLen === 0) sit *between* old lines and never
 *  contain `L`, so they never report `'EDITED'`. */
export function mapLine(hunks: EditHunk[], L: number): number | 'EDITED' {
  let delta = 0
  for (const h of hunks) {
    if (L < h.oldStart) return L + delta
    if (L < h.oldStart + Math.max(h.oldLen, 1) && h.oldLen !== 0) return 'EDITED'
    delta += h.newLen - h.oldLen
  }
  return L + delta
}

/** 1.0 at `hint`, strictly decreasing (but always > 0) as `line` moves away —
 *  guarantees that of two candidates with equal qsim/ctxSim, the one nearer
 *  `hint` always scores higher. */
function proximity(line: number, hint: number): number {
  const dist = Math.abs(line - hint)
  return 1 / (1 + dist * PROXIMITY_DECAY)
}

/** Average similarity between `context`'s before/after lines and the actual
 *  neighbor lines around 0-based candidate index `i` in `content`. `before`
 *  is nearest-last (its last entry sits immediately above `i`); `after` is
 *  nearest-first (its first entry sits immediately below `i`). Entries with
 *  no in-range neighbor are skipped. Returns `null` when no context line has
 *  an in-range neighbor at all (including when `context` is absent). */
function contextSimilarity(context: AnchorContext | undefined, content: string[], i: number): number | null {
  if (!context) return null
  let sum = 0
  let count = 0
  for (let k = 0; k < context.before.length; k++) {
    const dist = context.before.length - k // nearest-last ordering
    const idx = i - dist
    if (idx < 0) continue
    sum += similarity(normalizeWs(context.before[k]), normalizeWs(content[idx]))
    count++
  }
  for (let k = 0; k < context.after.length; k++) {
    const dist = k + 1 // nearest-first ordering
    const idx = i + dist
    if (idx >= content.length) continue
    sum += similarity(normalizeWs(context.after[k]), normalizeWs(content[idx]))
    count++
  }
  return count > 0 ? sum / count : null
}

/** Stage-2 scorer: fuzzy-match `quote` (+ optional `context`) against every
 *  line of `content` (0-based array), returning the best 1-based candidate
 *  line, or `null` when nothing qualifies.
 *
 *  Non-blank quote: the best candidate wins iff its score clears
 *  `ACCEPT_THRESHOLD`. When no context is available at all, `CONTEXT_WEIGHT`
 *  folds onto the quote term.
 *
 *  Blank/whitespace-only quote (`normalizeWs(quote) === ''`): the quote term
 *  carries no signal, so acceptance is gated purely on context —
 *  `ctxSim >= BLANK_QUOTE_CTX_MIN` is *sufficient* for eligibility (spec
 *  §"blank quote requires ctxSim ≥ 0.8"), NOT additionally subject to
 *  `ACCEPT_THRESHOLD`. So a lone eligible candidate with strong context is
 *  accepted even when the hint is far away; proximity only breaks ties among
 *  several eligible candidates. A blank quote can never anchor on proximity
 *  or a weak/coincidental context match alone. */
export function fuzzyFind(
  content: string[],
  quote: string,
  context: AnchorContext | undefined,
  hint: number
): { line: number; score: number } | null {
  const normQuote = normalizeWs(quote)
  const isBlankQuote = normQuote === ''

  let best: { line: number; score: number } | null = null
  for (let i = 0; i < content.length; i++) {
    const line = i + 1
    const ctxSim = contextSimilarity(context, content, i)

    if (isBlankQuote) {
      if (ctxSim === null || ctxSim < BLANK_QUOTE_CTX_MIN) continue // not eligible at all
      // Rank eligible candidates so proximity/ctxSim break ties; the ctxSim
      // gate above — not ACCEPT_THRESHOLD — decides acceptance.
      const score = (QUOTE_WEIGHT + CONTEXT_WEIGHT) * ctxSim + PROXIMITY_WEIGHT * proximity(line, hint)
      if (!best || score > best.score) best = { line, score }
      continue
    }

    const qsim = similarity(normalizeWs(content[i]), normQuote)
    const score = ctxSim === null
      ? (QUOTE_WEIGHT + CONTEXT_WEIGHT) * qsim + PROXIMITY_WEIGHT * proximity(line, hint)
      : QUOTE_WEIGHT * qsim + CONTEXT_WEIGHT * ctxSim + PROXIMITY_WEIGHT * proximity(line, hint)
    if (!best || score > best.score) best = { line, score }
  }

  // Blank quotes are already gated by the ctxSim eligibility check above, so
  // any surviving `best` is accepted; non-blank quotes must clear the threshold.
  if (!best) return null
  return isBlankQuote || best.score >= ACCEPT_THRESHOLD ? best : null
}

// ── the async three-stage re-anchor pipeline (spec §3, §4) ─────
// Composes the pure fns above (stage 1 mapLine, stage 2 fuzzyFind) with the git
// plumbing (git.ts) and the creation-time stamps (anchorStamp.ts) into the full
// pipeline. Per positional, unresolved comment: a STAMPED anchor runs stage
// 0→1→2→3; a LEGACY anchor (no stamp) runs stage 3 only, then heals forward on
// success. The pass mutates `comments`/`artifacts` in place; callers persist.

/** The git context the re-anchor pass runs against — the rendered surface plus
 *  the current tip/merge-base and the worktree (or null when the compare is a
 *  commit / checked out nowhere). */
export interface ReanchorCtx {
  workdir: string
  wt: string | null          // the compare worktree, or null (commit compare / not checked out)
  forAnchor: DiffSkeleton    // the rendered surface (stage 3 + render placement run against this)
  dirty: boolean
  currentTip: string         // skeleton.headSha  (current compare tip)
  currentMergeBase: string   // skeleton.mergeBase (current merge-base)
  session: SessionMeta       // for heal-forward stamping of legacy anchors
}

type PositionalAnchor = Extract<CommentAnchor, { kind: 'diff' } | { kind: 'artifact' }>

/** Split content into lines in stamping's line-number space (drop the empty tail
 *  a trailing newline leaves), so stage-2 candidate indices line up with mapLine's
 *  git-space line numbers. */
function splitLines(content: string): string[] {
  const lines = content.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** The stage-2 position hint for an EDITED line: the newStart of the hunk that
 *  contains L (a real replace hunk, oldLen > 0); falls back to the stamp's
 *  immutable origLine when L sits in no such hunk. */
function editedHint(hunks: EditHunk[], L: number, origLine: number): number {
  for (const h of hunks) {
    if (h.oldLen > 0 && L >= h.oldStart && L < h.oldStart + Math.max(h.oldLen, 1)) return h.newStart
  }
  return origLine
}

/** Find the rendered line in `file` at (side, line) by NUMBER (not text), with the
 *  same side discipline stage 3 uses — the hunk range it lives in, or null when the
 *  line is not present in any rendered hunk at this baseline. */
function findRenderedByLine(file: FileDiff | undefined, side: 'new' | 'old', line: number): string | null {
  if (!file) return null
  for (const h of file.hunks) {
    for (const l of h.lines) {
      const no = side === 'new' ? l.new : l.old
      if (no !== line) continue
      if (side === 'new' && l.kind === 'del') continue
      if (side === 'old' && l.kind === 'add') continue
      return h.range
    }
  }
  return null
}

/** Re-anchor positional comments against the current surface (mutates comments &
 *  artifacts in place — callers persist afterward). Skips `resolved` and every
 *  non-positional anchor exactly as before. */
export async function reanchorComments(ctx: ReanchorCtx, comments: Comment[], artifacts: Artifact[]): Promise<void> {
  const fileMap = new Map(ctx.forAnchor.files.map((f) => [f.path, f]))
  const filePaths = new Set(ctx.forAnchor.files.map((f) => f.path))
  const artMap = new Map(artifacts.map((a) => [a.path, a]))
  // Per-pass edit-list dedup (Q7): comments cluster on files, so compute
  // diffContents at most once per distinct (old blob, new content) pair. NO
  // cross-load/module-level cache — a persistent LRU is deferred until profiling
  // shows need (spec Q7: inline-first).
  const diffMemo = new Map<string, EditHunk[] | null>()

  async function memoDiff(blobSha: string, oldContent: string, newContent: string): Promise<EditHunk[] | null> {
    const key = `${blobSha}\n${newContent}` // blob shas carry no newline, so the boundary is unambiguous
    const cached = diffMemo.get(key)
    if (cached !== undefined || diffMemo.has(key)) return cached ?? null
    const hunks = await diffContents(oldContent, newContent)
    diffMemo.set(key, hunks)
    return hunks
  }

  /** Stage 0 blob probe: the file's CURRENT blob sha, or null when unresolvable. */
  async function currentBlob(a: PositionalAnchor): Promise<string | null> {
    if (a.kind === 'artifact') {
      try { return (await hashObjects(ctx.workdir, [a.path])).get(a.path) ?? null } catch { return null }
    }
    if (a.side === 'old') return blobShaAt(ctx.workdir, ctx.currentMergeBase, a.file)
    const rendered = fileMap.get(a.file)
    return rendered?.fileHash ?? (await blobShaAt(ctx.workdir, ctx.currentTip, a.file))
  }

  /** The current NEW-side content + its lines, or null when it cannot be read. */
  async function resolveNew(a: PositionalAnchor): Promise<{ content: string; lines: string[] } | null> {
    if (a.kind === 'artifact') {
      const art = artMap.get(a.path)
      if (!art) return null
      return { content: art.lines.join('\n'), lines: art.lines }
    }
    let content: string | null
    if (a.side === 'old') content = await showFile(ctx.workdir, ctx.currentMergeBase, a.file)
    else if (ctx.wt) { try { content = fs.readFileSync(nodePath.join(ctx.workdir, a.file), 'utf8') } catch { content = null } }
    else content = await showFile(ctx.workdir, ctx.currentTip, a.file)
    if (content === null) return null
    return { content, lines: splitLines(content) }
  }

  /** Render placement (spec §3): the mapped line is correct in FILE space; attach
   *  the thread to the rendered hunk it lives in. Off-diff → notInDiff (never
   *  outdated). Never marks outdated. */
  function renderPlace(c: Comment, a: PositionalAnchor): void {
    if (a.kind === 'artifact') {
      const art = artMap.get(a.path)
      const visible = !!art && a.line >= 1 && a.line <= art.lines.length
      if (c.status === 'outdated') c.status = 'queued'
      c.notInDiff = visible ? undefined : true
      return
    }
    const range = findRenderedByLine(fileMap.get(a.file), a.side, a.line)
    if (range !== null) a.hunkRange = range
    if (c.status === 'outdated') c.status = 'queued'
    c.notInDiff = range !== null ? undefined : true
  }

  /** Stages 0→1→2 for a stamped anchor. Returns true when it placed the comment
   *  (any of stage 0/1/2 succeeded → render placement done); false to fall through
   *  to stage 3. */
  async function tryStamped(c: Comment, a: PositionalAnchor): Promise<boolean> {
    const stamp = a.stamp!
    // Stage 0 — identity short-circuit: byte-identical content ⇒ stored line is
    // already correct in file space ⇒ NO diff call.
    const curBlob = await currentBlob(a)
    if (stamp.blobSha && curBlob && curBlob === stamp.blobSha) { renderPlace(c, a); return true }

    // Stage 1 prep — recover old content from the stamped blob.
    const oldContent = stamp.blobSha ? await catBlob(ctx.workdir, stamp.blobSha) : null

    // Rename tracking (committed stamps only): follow origPath→new when the anchor's
    // path is absent from the rendered surface, then read the new path below.
    if (a.kind === 'diff' && !filePaths.has(a.file) && stamp.surface === 'committed') {
      try {
        const moved = (await renameMap(ctx.workdir, stamp.headSha, ctx.currentTip)).get(stamp.origPath)
        if (moved) a.file = moved
      } catch { /* rename probe failed — fall through to stage 2/3 */ }
    }

    const resolved = await resolveNew(a)
    if (!resolved) return false // nothing to map/fuzz against → stage 3
    const { content: newContent, lines: contentLines } = resolved

    let hint = stamp.origLine ?? a.line
    // Stage 1 — deterministic diff mapping (needs a recoverable old blob).
    if (oldContent !== null) {
      const editList = await memoDiff(stamp.blobSha!, oldContent, newContent)
      if (editList === null) { renderPlace(c, a); return true } // identical → line unchanged
      // Map the IMMUTABLE stamp.origLine (the line in stamp.blobSha's own space that this
      // edit list is built from), NOT the already-mutated a.line — else the shift delta
      // compounds on every reload once stage 0 stops short-circuiting.
      const origLine = stamp.origLine ?? a.line
      const mapped = mapLine(editList, origLine)
      if (typeof mapped === 'number') { a.line = mapped; renderPlace(c, a); return true }
      hint = editedHint(editList, origLine, origLine) // 'EDITED' → stage 2 hint
    }

    // Stage 2 — fuzzy context fallback over the FULL new content.
    const hit = fuzzyFind(contentLines, a.lineContent, a.context, hint)
    if (hit) {
      a.line = hit.line
      a.lineContent = contentLines[hit.line - 1] // keep the outdated-card quote honest
      renderPlace(c, a)
      return true
    }
    return false // → stage 3
  }

  /** Stage 3 — exact-text floor (today's algorithm, verbatim), then outdated. On a
   *  legacy (unstamped) success, heal forward against the current surface. */
  async function stage3(c: Comment, a: PositionalAnchor): Promise<void> {
    const candidates: { line: number; range: string }[] = []
    if (a.kind === 'diff') {
      const file = fileMap.get(a.file)
      if (file) {
        for (const h of file.hunks) {
          for (const l of h.lines) {
            if (l.text !== a.lineContent) continue
            const no = a.side === 'new' ? l.new : l.old
            if (no == null) continue
            if (a.side === 'new' && l.kind === 'del') continue
            if (a.side === 'old' && l.kind === 'add') continue
            candidates.push({ line: no, range: h.range })
          }
        }
      }
    } else {
      const art = artMap.get(a.path)
      if (art) art.lines.forEach((text, idx) => { if (text === a.lineContent) candidates.push({ line: idx + 1, range: '' }) })
    }
    const best = pickNearest(candidates, a.line)
    if (best) {
      a.line = best.line
      if (a.kind === 'diff') a.hunkRange = best.range
      if (c.status === 'outdated') c.status = 'queued'
      c.notInDiff = undefined
      if (!a.stamp) c.anchor = await stampAnchor(ctx.workdir, ctx.session, a) // heal-forward (legacy only)
    } else {
      c.status = 'outdated'
      c.notInDiff = undefined
    }
  }

  for (const c of comments) {
    if (c.status === 'resolved') continue
    if (c.anchor.kind !== 'diff' && c.anchor.kind !== 'artifact') continue
    // all non-positional anchors are stable — untouched: section, summary, file,
    // question, plan-step, title, acceptance, deviation, hunk, and selection
    // (content-addressed via its own quote)
    const a = c.anchor
    try {
      if (a.stamp && (await tryStamped(c, a))) continue
      await stage3(c, a)
    } catch { /* a git failure on one comment must never abort the pass — leave it */ }
  }
}

function pickNearest(candidates: { line: number; range: string }[], target: number): { line: number; range: string } | null {
  if (candidates.length === 0) return null
  return candidates.reduce((a, b) => (Math.abs(b.line - target) < Math.abs(a.line - target) ? b : a))
}
