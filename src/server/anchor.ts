import type {
  AnchorContext, AnchorStamp, Artifact, Comment, CommentAnchor, DiffSkeleton, FileDiff, FocusTarget, ReviewState, SessionMeta
} from '../shared/types.js'
import { blobShaAt, catBlob, diffContents, hashObjects, renameMap, showFile } from './git.js'
import { readOnDisk, splitLines, stampAnchor } from './anchorStamp.js'

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

/** A string prepared for repeated similarity comparisons: its whitespace-
 *  normalized form plus that form's bigram multiset, computed once. fuzzyFind
 *  preps every content/context line and the quote up front so the candidate
 *  scan never rebuilds a normalization or bigram map. */
interface Prepped { norm: string; bigrams: Map<string, number> }

function prep(raw: string): Prepped {
  const norm = normalizeWs(raw)
  return { norm, bigrams: bigramCounts(norm) }
}

/** Sørensen–Dice coefficient over pre-computed bigram multisets, 0..1. */
function similarityPrepped(a: Prepped, b: Prepped): number {
  if (a.norm === '' && b.norm === '') return 1
  if (a.norm === '' || b.norm === '') return 0
  if (a.norm.length === 1 || b.norm.length === 1) return a.norm === b.norm ? 1 : 0

  let intersection = 0
  for (const [bg, count] of a.bigrams) {
    const other = b.bigrams.get(bg)
    if (other) intersection += Math.min(count, other)
  }
  const total = (a.norm.length - 1) + (b.norm.length - 1)
  return (2 * intersection) / total
}

/** Sørensen–Dice coefficient over character bigrams, 0..1. Hand-rolled (no
 *  new dependency). Callers pass already-normalized strings — this function
 *  does not normalize. */
export function similarity(a: string, b: string): number {
  return similarityPrepped({ norm: a, bigrams: bigramCounts(a) }, { norm: b, bigrams: bigramCounts(b) })
}

/** The `-U0` edit list between an old and a new content (a later task adapts
 *  `parseUnifiedDiff` output into this shape). */
export interface EditHunk { oldStart: number; oldLen: number; newStart: number; newLen: number }

/** Stage-1 walker (spec §3 stage 1 step 5): deterministically map a 1-based
 *  line `L` in OLD-content space through ascending, non-overlapping `hunks`
 *  to its position in NEW-content space. Returns `'EDITED'` when `L` falls
 *  inside a real edited region (oldLen >= 1) — the caller falls back to
 *  stage 2. Pure insertions (oldLen === 0) sit *between* old lines and never
 *  contain `L`, so they never report `'EDITED'`: git's `-N,0 +M,k` header
 *  means "inserted AFTER old line N", so `L === oldStart` is still above the
 *  insertion and keeps its position. */
export function mapLine(hunks: EditHunk[], L: number): number | 'EDITED' {
  let delta = 0
  for (const h of hunks) {
    if (L < h.oldStart || (h.oldLen === 0 && L === h.oldStart)) return L + delta
    if (h.oldLen !== 0 && L < h.oldStart + h.oldLen) return 'EDITED'
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

/** Average similarity between the prepped `context` before/after lines and the
 *  actual neighbor lines around 0-based candidate index `i` in prepped
 *  `content`. `before` is nearest-last (its last entry sits immediately above
 *  `i`); `after` is nearest-first (its first entry sits immediately below `i`).
 *  Entries with no in-range neighbor are skipped. Returns `null` when no
 *  context line has an in-range neighbor at all (including when `context` is
 *  absent). */
function contextSimilarity(context: { before: Prepped[]; after: Prepped[] } | undefined, content: Prepped[], i: number): number | null {
  if (!context) return null
  let sum = 0
  let count = 0
  for (let k = 0; k < context.before.length; k++) {
    const dist = context.before.length - k // nearest-last ordering
    const idx = i - dist
    if (idx < 0) continue
    sum += similarityPrepped(context.before[k], content[idx])
    count++
  }
  for (let k = 0; k < context.after.length; k++) {
    const dist = k + 1 // nearest-first ordering
    const idx = i + dist
    if (idx >= content.length) continue
    sum += similarityPrepped(context.after[k], content[idx])
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
  // Prep everything once: each content line is compared against the quote and
  // (as the window slides) up to 2·CONTEXT_N context neighbors, so per-candidate
  // recomputation of normalization/bigrams would dominate the scan.
  const preppedQuote = prep(quote)
  const preppedContent = content.map(prep)
  const preppedCtx = context ? { before: context.before.map(prep), after: context.after.map(prep) } : undefined
  const isBlankQuote = preppedQuote.norm === ''

  let best: { line: number; score: number } | null = null
  for (let i = 0; i < content.length; i++) {
    const line = i + 1
    const ctxSim = contextSimilarity(preppedCtx, preppedContent, i)

    if (isBlankQuote) {
      if (ctxSim === null || ctxSim < BLANK_QUOTE_CTX_MIN) continue // not eligible at all
      // Rank eligible candidates so proximity/ctxSim break ties; the ctxSim
      // gate above — not ACCEPT_THRESHOLD — decides acceptance.
      const score = (QUOTE_WEIGHT + CONTEXT_WEIGHT) * ctxSim + PROXIMITY_WEIGHT * proximity(line, hint)
      if (!best || score > best.score) best = { line, score }
      continue
    }

    const qsim = similarityPrepped(preppedContent[i], preppedQuote)
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
 *  the current tip/merge-base and whether the compare is checked out in a worktree
 *  (`workdir` IS that worktree when it is). */
export interface ReanchorCtx {
  workdir: string
  hasWorktree: boolean       // is the compare checked out? (false: commit compare / checked out nowhere)
  forAnchor: DiffSkeleton    // the rendered surface (stage 3 + render placement run against this)
  currentTip: string         // skeleton.headSha  (current compare tip)
  currentMergeBase: string   // skeleton.mergeBase (current merge-base)
  session: SessionMeta       // for heal-forward stamping of legacy anchors
}

type PositionalAnchor = Extract<CommentAnchor, { kind: 'diff' } | { kind: 'artifact' }>

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

/** What one re-anchor attempt concluded about one anchor. The anchor's positional
 *  fields (`line`/`endLine`/`hunkRange`/`lineContent`/`file`) are already updated in
 *  place; the verdict carries only what the anchor's OWNER has to record — a
 *  `Comment` maps it onto status/`notInDiff`/`anchorEdited`, a bare `FocusTarget`
 *  (narration block, diagram node, `point` stop) onto `stale`. */
export interface AnchorVerdict {
  /** the anchor was located: stage 0/1/2 placed it, or stage 3 found its exact text */
  located: boolean
  /** located, but the line is not present in any rendered hunk of the surface */
  offSurface: boolean
  /** stage 1 proved the anchored line ITSELF was rewritten since the stamp. Says
   *  nothing about where the anchor ended up (see `Comment.anchorEdited`). */
  edited: boolean
  /** a freshly stamped anchor for a legacy (unstamped) one that healed forward */
  stamped?: CommentAnchor
}

/** One load's re-anchor pass, bound to a surface. Create it once per load and feed
 *  it every anchor family (comments, then the bare FocusTargets) so they share the
 *  per-pass git memos — a second pass would re-run every blob probe and diff. */
export interface ReanchorPass {
  /** Re-anchor one positional anchor in place. `null` = the attempt failed outright
   *  (a git error on this anchor); the anchor is untouched and the caller must draw
   *  no conclusion from it. Never throws.
   *
   *  `heal` (default true): stamp a legacy (unstamped) anchor that stage 3 placed, so
   *  later loads run the full pipeline. Callers that cannot PERSIST the fresh stamp
   *  must pass `false` — stamping costs ~6 git spawns and would be recomputed and
   *  thrown away on every single load. */
  reanchor(a: PositionalAnchor, opts?: { heal?: boolean }): Promise<AnchorVerdict | null>
}

/** Build the three-stage pass (spec §3, §4) against `ctx`'s surface. `artifacts`
 *  supplies the content for `kind: 'artifact'` anchors. */
export function createReanchorPass(ctx: ReanchorCtx, artifacts: Artifact[]): ReanchorPass {
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

  // Per-pass memo for the remaining per-comment git lookups (same inline-first
  // rationale as diffMemo): comments cluster on files, so each distinct blob
  // probe / blob read / new-content read / rename map runs at most once per
  // pass. Keys are namespaced (`kind:detail`); a rename that mutates a.file
  // changes the key, so the renamed path is looked up fresh — behavior per
  // comment is unchanged, only duplicate work is skipped.
  const lookupMemo = new Map<string, Promise<unknown>>()
  function memoLookup<T>(key: string, compute: () => Promise<T>): Promise<T> {
    let p = lookupMemo.get(key) as Promise<T> | undefined
    if (!p) { p = compute(); lookupMemo.set(key, p) }
    return p
  }

  /** Stage 0 blob probe: the file's CURRENT blob sha, or null when unresolvable. */
  async function currentBlob(a: PositionalAnchor): Promise<string | null> {
    if (a.kind === 'artifact') {
      return memoLookup(`blob:art:${a.path}`, async () => {
        try { return (await hashObjects(ctx.workdir, [a.path])).get(a.path) ?? null } catch { return null }
      })
    }
    if (a.side === 'old') return memoLookup(`blob:old:${a.file}`, () => blobShaAt(ctx.workdir, ctx.currentMergeBase, a.file))
    const rendered = fileMap.get(a.file)
    return rendered?.fileHash ?? (await memoLookup(`blob:new:${a.file}`, () => blobShaAt(ctx.workdir, ctx.currentTip, a.file)))
  }

  /** The current NEW-side content + its lines, or null when it cannot be read. */
  async function resolveNew(a: PositionalAnchor): Promise<{ content: string; lines: string[] } | null> {
    if (a.kind === 'artifact') {
      const art = artMap.get(a.path)
      if (!art) return null
      return { content: art.lines.join('\n'), lines: art.lines }
    }
    let content: string | null
    if (a.side === 'old') content = await memoLookup(`show:old:${a.file}`, () => showFile(ctx.workdir, ctx.currentMergeBase, a.file))
    else if (ctx.hasWorktree) content = await memoLookup(`disk:${a.file}`, async () => readOnDisk(ctx.workdir, a.file))
    else content = await memoLookup(`show:new:${a.file}`, () => showFile(ctx.workdir, ctx.currentTip, a.file))
    if (content === null) return null
    return { content, lines: splitLines(content) }
  }

  /** Render placement (spec §3): the mapped line is correct in FILE space; attach
   *  the thread to the rendered hunk it lives in. Returns whether the line is
   *  OFF-SURFACE (valid in the file, absent from every rendered hunk). */
  function renderPlace(a: PositionalAnchor): boolean {
    if (a.kind === 'artifact') {
      const art = artMap.get(a.path)
      return !(!!art && a.line >= 1 && a.line <= art.lines.length)
    }
    const range = findRenderedByLine(fileMap.get(a.file), a.side, a.line)
    if (range !== null) a.hunkRange = range
    return range === null
  }
  const placed = (a: PositionalAnchor, edited: boolean): AnchorVerdict =>
    ({ located: true, offSurface: renderPlace(a), edited })
  /** The current content is byte-identical to the stamped blob, so the anchor belongs
   *  exactly where it was stamped — undoing any move an earlier load persisted. */
  const backToStamp = (a: PositionalAnchor, stamp: AnchorStamp): AnchorVerdict => {
    setLine(a, stamp.origLine)
    return placed(a, false)
  }

  /** Stages 0→1→2 for a stamped anchor. Returns a verdict when it placed the anchor
   *  (any of stage 0/1/2 succeeded); `null` to fall through to stage 3, reporting
   *  through `out.edited` whether stage 1 saw the line rewritten. */
  async function tryStamped(a: PositionalAnchor, out: { edited: boolean }): Promise<AnchorVerdict | null> {
    const stamp = a.stamp!
    // Stage 0 — identity short-circuit: byte-identical content ⇒ NO diff call. The
    // line that is correct in that content is the IMMUTABLE stamp.origLine, not the
    // stored `a.line`: stage 1/2 may have moved the anchor on an earlier load and
    // review.ts persisted the move, so a revert to the stamped blob must undo it.
    const curBlob = await currentBlob(a)
    if (stamp.blobSha && curBlob && curBlob === stamp.blobSha) return backToStamp(a, stamp)

    // Stage 1 prep — recover old content from the stamped blob.
    const oldContent = stamp.blobSha
      ? await memoLookup(`cat:${stamp.blobSha}`, () => catBlob(ctx.workdir, stamp.blobSha!))
      : null

    // Rename tracking (committed stamps only): follow origPath→new when the anchor's
    // path is absent from the rendered surface, then read the new path below.
    if (a.kind === 'diff' && !filePaths.has(a.file) && stamp.surface === 'committed') {
      try {
        const renames = await memoLookup(`ren:${stamp.headSha}`, () => renameMap(ctx.workdir, stamp.headSha, ctx.currentTip))
        const moved = renames.get(stamp.origPath)
        if (moved) a.file = moved
      } catch { /* rename probe failed — fall through to stage 2/3 */ }
    }

    const resolved = await resolveNew(a)
    if (!resolved) return null // nothing to map/fuzz against → stage 3
    const { content: newContent, lines: contentLines } = resolved

    let hint = stamp.origLine ?? a.line
    // Stage 1 — deterministic diff mapping (needs a recoverable old blob).
    if (oldContent !== null) {
      const editList = await memoDiff(stamp.blobSha!, oldContent, newContent)
      if (editList === null) return backToStamp(a, stamp) // identical content → stamped line
      // Map the IMMUTABLE stamp.origLine (the line in stamp.blobSha's own space that this
      // edit list is built from), NOT the already-mutated a.line — else the shift delta
      // compounds on every reload once stage 0 stops short-circuiting.
      const origLine = stamp.origLine ?? a.line
      const mapped = mapLine(editList, origLine)
      if (typeof mapped === 'number') { setLine(a, mapped); return placed(a, false) }
      // 'EDITED': the anchored line itself was rewritten. The flag records THAT — not
      // where the anchor ends up; stage 2 may re-place it on the replacement code, or
      // it may stay put and be flagged notInDiff/outdated/stale below (#18).
      out.edited = true
      hint = editedHint(editList, origLine, origLine) // 'EDITED' → stage 2 hint
    }

    // Stage 2 — fuzzy context fallback over the FULL new content.
    const hit = fuzzyFind(contentLines, a.lineContent, a.context, hint)
    if (hit) {
      // Stage 1's 'EDITED' only means the line fell inside a hunk's OLD range, and git
      // routinely parks an untouched line (`}`, a blank, a duplicated import) on the
      // deleted side of a replace to keep the rest of its alignment. The flag claims
      // the quoted text is gone, so only assert it when the text really changed —
      // whitespace-insensitively, since re-indentation rewrites nothing.
      const changed = normalizeWs(contentLines[hit.line - 1]) !== normalizeWs(a.lineContent)
      setLine(a, hit.line)
      a.lineContent = contentLines[hit.line - 1] // keep the outdated-card quote honest
      return placed(a, out.edited && changed)
    }
    return null // → stage 3
  }

  /** Stage 3 — exact-text floor (today's algorithm, verbatim), then "not located".
   *  On a legacy (unstamped) success, heal forward against the current surface when
   *  `heal` (the caller can persist the fresh stamp). */
  async function stage3(a: PositionalAnchor, edited: boolean, heal: boolean): Promise<AnchorVerdict> {
    // An empty/whitespace-only quote is not evidence: it exact-matches EVERY blank
    // rendered line, and pickNearest would then move the anchor onto whichever one
    // sits closest and call it located. Nothing to match on ⇒ not located.
    if (normalizeWs(a.lineContent) === '') return { located: false, offSurface: false, edited }
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
    if (!best) return { located: false, offSurface: false, edited }
    setLine(a, best.line)
    if (a.kind === 'diff') a.hunkRange = best.range
    // the exact quote is on a rendered line — nothing was rewritten
    const stamped = heal && !a.stamp ? await stampAnchor(ctx.workdir, ctx.session, a) : undefined // heal-forward (legacy only)
    return { located: true, offSurface: false, edited: false, ...(stamped ? { stamped } : {}) }
  }

  return {
    async reanchor(a: PositionalAnchor, opts?: { heal?: boolean }): Promise<AnchorVerdict | null> {
      try {
        const out = { edited: false }
        if (a.stamp) {
          const done = await tryStamped(a, out)
          if (done) return done
        }
        return await stage3(a, out.edited, opts?.heal ?? true)
      } catch {
        return null // a git failure on one anchor must never abort the pass — leave it
      }
    }
  }
}

/** Move an anchor to `line`, carrying an `endLine` range with it — a range whose
 *  start moved but whose end stayed would silently mis-span the code it points at. */
function setLine(a: PositionalAnchor, line: number): void {
  if (a.kind === 'diff' && a.endLine !== undefined) a.endLine = Math.max(line, a.endLine + (line - a.line))
  a.line = line
}

/** Re-anchor positional comments against the current surface (mutates comments &
 *  artifacts in place — callers persist afterward). Skips every non-positional
 *  anchor. Pass a shared `pass` to reuse one load's git memos across anchor families.
 *
 *  `resolved` comments are re-anchored too (#18: the agent's fix commit rewrites
 *  the very lines it was asked about and then calls `resolve_comment`, so the most
 *  drift-prone comments in a review are exactly the resolved ones), but their
 *  STATUS is frozen: a resolution is a historical record, never re-stated to
 *  'outdated' by a later load. When a resolved comment's anchor can no longer be
 *  located, it is flagged `notInDiff` instead — anchored nowhere, so the UI stops
 *  rendering it inline at a line that no longer holds the commented code. */
export async function reanchorComments(
  ctx: ReanchorCtx, comments: Comment[], artifacts: Artifact[], pass: ReanchorPass = createReanchorPass(ctx, artifacts)
): Promise<void> {
  for (const c of comments) {
    if (c.anchor.kind !== 'diff' && c.anchor.kind !== 'artifact') continue
    // all non-positional anchors are stable — untouched: section, summary, file,
    // question, plan-step, title, acceptance, deviation, hunk, and selection
    // (content-addressed via its own quote)
    // A legacy (pre-stamp) anchor with an empty quote carries no evidence to
    // re-anchor from — an empty quote exact-matches every blank rendered line, so
    // stage 3 would decline it and mark it outdated on every load even when nothing
    // changed. Mirrors the same skip in reanchorFocusTargets: left exactly as it is.
    if (!c.anchor.stamp && normalizeWs(c.anchor.lineContent) === '') continue
    const v = await pass.reanchor(c.anchor)
    // `anchorEdited` is a per-load verdict, not accumulated state: this load's own
    // stage-1 'EDITED' is the ONLY thing that may set it, so it is cleared here
    // UNCONDITIONALLY — including on a failed attempt (`v === null`). A load that
    // cannot re-derive the verdict (no blobSha, a gc'd blob, a git failure) has no
    // evidence for it, and a stale `true` would otherwise outlive that evidence.
    c.anchorEdited = v?.edited || undefined
    if (!v) continue // attempt failed — the anchor and every other field stay as they were
    if (v.located) {
      if (c.status === 'outdated') c.status = 'queued'
      c.notInDiff = v.offSurface || undefined
      if (v.stamped) c.anchor = v.stamped
    } else if (c.status === 'resolved') {
      // Status frozen (see the fn doc): a resolution outlives its anchor. The anchor
      // is nowhere on the surface, so flag it off-diff rather than leaving it to
      // render inline at whatever code now occupies its old line number.
      c.notInDiff = true
    } else {
      c.status = 'outdated'
      c.notInDiff = undefined
    }
  }
}

/** Re-anchor the bare `FocusTarget`s of a review — narration blocks, diagram nodes
 *  and `point`/walkthrough stops (#18, narration scope). Same pipeline, same
 *  guarantee as comments: the anchor is re-mapped onto the code it was written
 *  against, or explicitly flagged `stale` — never left pointing at a line number
 *  whose meaning has changed underneath it. Mutates the targets in place; the
 *  verdict is recomputed from the immutable stamp on every load, so nothing has to
 *  be persisted for it.
 *
 *  Heal-forward is OFF here for exactly that reason: nothing on this path writes the
 *  annotations/chat rows back, so a stamp minted for a legacy target would be
 *  discarded and re-minted (~6 git spawns) on every load. Legacy targets keep running
 *  stage 3 only. */
export async function reanchorFocusTargets(pass: ReanchorPass, targets: Iterable<FocusTarget | undefined>): Promise<void> {
  for (const t of targets) {
    if (t?.kind !== 'diff') continue
    // A legacy stop (pre-stamp `point` froze `lineContent: ''` with no stamp) carries
    // no evidence at all — nothing to re-anchor from, and no stamp whose absence a
    // verdict could be pinned on. Skip it entirely (stage 3 declines empty quotes too,
    // but that would flag it `lost`; a legacy stop is left exactly as it was).
    if (!t.stamp && normalizeWs(t.lineContent) === '') continue
    const v = await pass.reanchor(t, { heal: false })
    if (!v) continue
    t.stale = !v.located ? 'lost' : v.offSurface ? 'off-surface' : undefined
  }
}

/** Every `FocusTarget` in a review that the re-anchor pass owns: the anchors of
 *  narration blocks and diagram nodes (persisted in the annotations) plus the stops
 *  of every `point` action frozen on a chat message. Non-diff targets are returned
 *  too and simply skipped by the pass — the caller does no filtering. */
export function reviewFocusTargets(state: ReviewState): FocusTarget[] {
  const out: FocusTarget[] = []
  for (const s of state.annotations?.sections ?? []) {
    for (const b of s.narration) if (b.anchor) out.push(b.anchor)
    for (const n of s.diagram?.nodes ?? []) if (n.anchor) out.push(n.anchor)
  }
  for (const thread of state.chats ?? []) {
    for (const m of thread.messages) {
      for (const action of m.actions ?? []) {
        if (action.kind === 'point') for (const stop of action.stops) out.push(stop.target)
      }
    }
  }
  return out
}

function pickNearest(candidates: { line: number; range: string }[], target: number): { line: number; range: string } | null {
  if (candidates.length === 0) return null
  return candidates.reduce((a, b) => (Math.abs(b.line - target) < Math.abs(a.line - target) ? b : a))
}
