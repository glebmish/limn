import type { AnchorContext, Artifact, Comment, DiffSkeleton } from '../shared/types.js'

// ── anchor v2: pure, git-free foundation ───────────────────────
// (stage-1 diff mapping + stage-2 fuzzy context match; the async pipeline that
// calls these, and the git plumbing that feeds them, land in a later task.)

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

/** Re-anchor positional comments after the branch changed (mutates comments).
 *  Exact-content match; nearest line wins on duplicates; no match → outdated. */
export function reanchorComments(comments: Comment[], skeleton: DiffSkeleton, artifacts: Artifact[]): void {
  const fileMap = new Map(skeleton.files.map((f) => [f.path, f]))
  const artMap = new Map(artifacts.map((a) => [a.path, a]))

  for (const c of comments) {
    if (c.status === 'resolved') continue

    if (c.anchor.kind === 'diff') {
      const file = fileMap.get(c.anchor.file)
      const side = c.anchor.side
      const candidates: { line: number; range: string }[] = []
      if (file) {
        for (const h of file.hunks) {
          for (const l of h.lines) {
            if (l.text !== c.anchor.lineContent) continue
            const no = side === 'new' ? l.new : l.old
            if (no == null) continue
            if (side === 'new' && l.kind === 'del') continue
            if (side === 'old' && l.kind === 'add') continue
            candidates.push({ line: no, range: h.range })
          }
        }
      }
      const best = pickNearest(candidates, c.anchor.line)
      if (best) {
        c.anchor = { ...c.anchor, line: best.line, hunkRange: best.range }
        if (c.status === 'outdated') c.status = 'queued'
      } else {
        c.status = 'outdated'
      }
    } else if (c.anchor.kind === 'artifact') {
      const art = artMap.get(c.anchor.path)
      const candidates: { line: number; range: string }[] = []
      if (art) {
        art.lines.forEach((text, idx) => {
          if (text === (c.anchor as { lineContent: string }).lineContent) candidates.push({ line: idx + 1, range: '' })
        })
      }
      const best = pickNearest(candidates, c.anchor.line)
      if (best) {
        c.anchor = { ...c.anchor, line: best.line }
        if (c.status === 'outdated') c.status = 'queued'
      } else {
        c.status = 'outdated'
      }
    }
    // all non-positional anchors are stable — untouched: section, summary, file,
    // question, plan-step, title, acceptance, deviation, hunk, and selection
    // (content-addressed via its own quote)
  }
}

function pickNearest(candidates: { line: number; range: string }[], target: number): { line: number; range: string } | null {
  if (candidates.length === 0) return null
  return candidates.reduce((a, b) => (Math.abs(b.line - target) < Math.abs(a.line - target) ? b : a))
}
