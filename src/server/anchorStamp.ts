import fs from 'node:fs'
import { effectiveRef } from '../shared/types.js'
import type { AnchorContext, AnchorStamp, CommentAnchor, SessionMeta } from '../shared/types.js'
import { CONTEXT_N } from './anchor.js'
import { containedPath } from './fileEdits.js'
import { EMPTY_TREE, blobShaAt, hashObjectsWrite, headSha, mergeBase, pathHasChanges, showFile } from './git.js'

// ── creation-time anchor stamping ──────────────────────────────
// Enrich a positional comment anchor with its immutable AnchorStamp + captured
// AnchorContext at CREATION time, so the async re-anchor pipeline (a later task)
// can map the comment through later diffs from a known origin. Stamping is
// once-only (never overwrites) and never throws — a comment must never be
// rejected because git stamping degraded.

type SurfaceState = AnchorStamp['surface']

/** Read a working-tree file as text, or null if it is gone/unreadable/binary.
 *  Matches syntheticAddedFile's on-disk read (git.ts). Shared with the
 *  re-anchor pipeline's new-content resolution (anchor.ts).
 *  `path` is caller-supplied (an agent's comment anchor), so it is held to the
 *  worktree — an escaping path reads as absent rather than leaking its content
 *  into the stamped context. */
export function readOnDisk(workdir: string, path: string): string | null {
  try { return fs.readFileSync(containedPath(workdir, path), 'utf8') }
  catch { return null }
}

/** Split content into lines in the SAME line-number space stamping uses, dropping
 *  the single empty tail a trailing newline leaves (like syntheticAddedFile).
 *  Shared with stage-2 fuzzy matching (anchor.ts), which must agree on this
 *  drop-empty-tail convention so candidate indices line up with mapLine's
 *  git-space line numbers. */
export function splitLines(content: string): string[] {
  const lines = content.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Slice ±CONTEXT_N context around 1-based line `L` from resolved `content`, and
 *  heal an empty incoming `lineContent` to the real text at `L`. Returns empty
 *  (no context, no heal) when content is absent or `L` is out of range — an
 *  agent-hallucinated line still gets a stamp, just no context (spec §2). */
function resolveContext(content: string | null, L: number, lineContent: string): { context?: AnchorContext; lineContent?: string } {
  if (content == null) return {}
  const lines = splitLines(content)
  if (L < 1 || L > lines.length) return {}
  const before = lines.slice(Math.max(0, L - 1 - CONTEXT_N), L - 1)
  const after = lines.slice(L, Math.min(lines.length, L + CONTEXT_N))
  const context: AnchorContext = { before, after }
  // heal only when the incoming quote is empty/absent (fixes agent anchors, spec §2 step 4)
  return lineContent ? { context } : { context, lineContent: lines[L - 1] }
}

/** The tree-level facts a stamp needs: the compare tip and the merge-base. They are
 *  the same for every anchor stamped against one tree, so a caller stamping a whole
 *  pass resolves them once (`resolveStampTree`) and hands them to every `stampAnchor`. */
export interface StampTree { head: string; mb: string }

/** headSha/mergeBase — the tree-level fields shared by both anchor kinds.
 *  headSha is NOT swallowed: if it throws (e.g. a non-repo workdir) the caller's
 *  outer try/catch returns the anchor unstamped rather than fabricate a stamp. */
async function resolveTreeState(workdir: string, session: SessionMeta): Promise<StampTree> {
  const compareEff = effectiveRef(session.pair.compare)
  const baseEff = effectiveRef(session.pair.base)
  const head = await headSha(workdir, compareEff)
  const mb = await mergeBase(workdir, baseEff, compareEff).catch(() => EMPTY_TREE)
  return { head, mb }
}

/** Resolve the shared tree facts once for a whole stamping pass (a generation's
 *  narration blocks + diagram nodes, a batch of minted hotspot comments). Never
 *  throws: `undefined` — a non-repo workdir — just leaves each `stampAnchor` to
 *  resolve for itself and degrade to an unstamped anchor exactly as before. */
export async function resolveStampTree(workdir: string, session: SessionMeta): Promise<StampTree | undefined> {
  try { return await resolveTreeState(workdir, session) } catch { return undefined }
}

/** Stamp a `kind: 'diff'` anchor. Blob source follows per-file state so the
 *  resolved content is always in the same line space as `anchor.line`:
 *   - side 'old'          → base blob at mergeBase (base space)
 *   - side 'new', clean   → tip blob at headSha (== worktree space for a clean file)
 *   - side 'new', dirty/untracked → on-disk content, persisted `-w` so it is
 *     recoverable later (worktree space).
 *  `surface` names that same line space, so it is derived from the SAME per-file
 *  signal — an unrelated dirty file elsewhere in the tree says nothing about the
 *  space this line was written in (and would cost the anchor its rename tracking). */
async function stampDiff(workdir: string, tree: StampTree, anchor: Extract<CommentAnchor, { kind: 'diff' }>): Promise<CommentAnchor> {
  const { head, mb } = tree
  // side 'old' is base space, which is committed by construction — no probe needed
  const changed = anchor.side === 'new' && (await pathHasChanges(workdir, anchor.file))
  const surface: SurfaceState = changed ? 'dirty' : 'committed'

  let content: string | null
  let blobSha: string | undefined
  if (anchor.side === 'old') {
    content = await showFile(workdir, mb, anchor.file)
    blobSha = (await blobShaAt(workdir, mb, anchor.file)) ?? undefined
  } else if (changed) {
    content = readOnDisk(workdir, anchor.file)
    blobSha = (await hashObjectsWrite(workdir, [anchor.file])).get(anchor.file)
  } else {
    content = await showFile(workdir, head, anchor.file)
    blobSha = (await blobShaAt(workdir, head, anchor.file)) ?? undefined
  }

  const stamp: AnchorStamp = { headSha: head, mergeBase: mb, blobSha, surface, origLine: anchor.line, origPath: anchor.file }
  const { context, lineContent } = resolveContext(content, anchor.line, anchor.lineContent)
  return { ...anchor, stamp, ...(context ? { context } : {}), ...(lineContent !== undefined ? { lineContent } : {}) }
}

/** Stamp a `kind: 'artifact'` anchor. Artifacts are read from the working tree on
 *  disk (may be untracked docs), so content + blob are always the `-w` on-disk
 *  form; headSha/mergeBase are best-effort provenance (Q10). `surface` names this
 *  file's own line space (same per-file rule as stampDiff). */
async function stampArtifact(workdir: string, tree: StampTree, anchor: Extract<CommentAnchor, { kind: 'artifact' }>): Promise<CommentAnchor> {
  const { head, mb } = tree
  const surface: SurfaceState = (await pathHasChanges(workdir, anchor.path)) ? 'dirty' : 'committed'
  const content = readOnDisk(workdir, anchor.path)
  const blobSha = (await hashObjectsWrite(workdir, [anchor.path])).get(anchor.path)
  const stamp: AnchorStamp = { headSha: head, mergeBase: mb, blobSha, surface, origLine: anchor.line, origPath: anchor.path }
  const { context, lineContent } = resolveContext(content, anchor.line, anchor.lineContent)
  return { ...anchor, stamp, ...(context ? { context } : {}), ...(lineContent !== undefined ? { lineContent } : {}) }
}

/** Enrich a positional comment anchor with its immutable stamp + context at
 *  creation. No-op (returns the anchor untouched) for non-positional anchors and
 *  already-stamped ones (once-only — Q4 immutability). Never throws: any git
 *  failure returns the anchor with whatever resolved, or unchanged.
 *
 *  `tree`: the pre-resolved tree facts, for a caller stamping many anchors against
 *  one tree (`resolveStampTree`). Omitted, each call resolves them itself. */
export async function stampAnchor(workdir: string, session: SessionMeta, anchor: CommentAnchor, tree?: StampTree): Promise<CommentAnchor> {
  if (anchor.kind !== 'diff' && anchor.kind !== 'artifact') return anchor
  if (anchor.stamp) return anchor
  try {
    const resolved = tree ?? await resolveTreeState(workdir, session)
    return anchor.kind === 'diff'
      ? await stampDiff(workdir, resolved, anchor)
      : await stampArtifact(workdir, resolved, anchor)
  } catch {
    return anchor // stamping must never reject a comment
  }
}
