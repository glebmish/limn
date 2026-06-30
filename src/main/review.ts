import type { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import type { LoadedReview } from '../shared/ipc.js'
import type { AgentRef, AgentWriteCapability, Artifact, DiffSkeleton, FileDiff, RefPair, RefSide, ReviewState, SessionMeta } from '../shared/types.js'
import { effectiveRef, fileEffectivelyExcluded } from '../shared/types.js'
import {
  attachSinceHunks, branchCheckedOutAt, describeSide, diffSince, diffSinceWorking, getDiff, hashObjects, headSha, isDirty, locateSide,
  log, markSince, mergedWorkingDiff, resolveRefInput, workingTreeDiff
} from './git.js'
import * as dao from './db/sessions.js'
import { detectArtifacts, loadArtifact } from './artifacts.js'
import { reanchorComments } from './anchor.js'

/** Detect spec/plan artifacts for a review and load their contents. When `persist`
 *  is true and detection had to run (no cached refs), the result is cached to the
 *  session row — the transient (preview) path passes false to stay write-free. */
export async function loadArtifactsFor(
  db: DatabaseSync, sessionId: number, repo: string, branch: string,
  refs: { role: 'spec' | 'plan'; path: string }[], changedPaths: string[], persist = true
): Promise<Artifact[]> {
  if (refs.length === 0) {
    refs = await detectArtifacts(repo, branch, changedPaths)
    if (refs.length > 0 && persist) dao.setArtifacts(db, sessionId, refs)
  }
  const out: Artifact[] = []
  for (const r of refs) {
    try { out.push(loadArtifact(repo, r.path, r.role)) } catch { /* artifact file gone — skip */ }
  }
  return out
}

/** The working directory the review's writes + working-tree reads run in: the
 *  worktree currently holding the compare branch, else the primary repo. The repo
 *  path stays the identity/lock key; this is the cwd handed to git + the engine. */
export async function resolveWorkdir(repo: string, pair: RefPair): Promise<string> {
  if (pair.compare.kind !== 'branch') return repo
  return (await branchCheckedOutAt(repo, pair.compare.symbol)) ?? repo
}

/** Compute edit capability from live git state. All agent write gates use this. */
export async function writeCapabilityFor(repo: string, compare: RefSide): Promise<AgentWriteCapability> {
  if (compare.kind !== 'branch') {
    return { enabled: false, reason: 'not-branch', branch: null, workdir: null }
  }
  const workdir = await branchCheckedOutAt(repo, compare.symbol)
  if (!workdir) {
    return { enabled: false, reason: 'not-checked-out', branch: compare.symbol, workdir: null }
  }
  if (await isDirty(workdir)) {
    return { enabled: false, reason: 'dirty', branch: compare.symbol, workdir }
  }
  return { enabled: true, reason: 'available', branch: compare.symbol, workdir }
}

/** Union two FileDiff lists by path, concatenating hunks for shared paths — used
 *  to re-anchor comments across the spine + volatile band in one pass. */
function mergeFilesByPath(a: FileDiff[], b: FileDiff[]): FileDiff[] {
  const out = new Map(a.map((f) => [f.path, { ...f, hunks: [...f.hunks] }]))
  for (const f of b) {
    const ex = out.get(f.path)
    if (ex) ex.hunks.push(...f.hunks)
    else out.set(f.path, { ...f, hunks: [...f.hunks] })
  }
  return [...out.values()]
}

function branchSurfaceHash(head: string, volatile: FileDiff[]): string {
  if (volatile.length === 0) return head
  const h = createHash('sha256')
  h.update(`head\0${head}\0`)
  for (const f of [...volatile].sort((a, b) => a.path.localeCompare(b.path))) {
    h.update(`file\0${f.path}\0${f.status}\0${f.fileHash ?? ''}\0${f.add}\0${f.del}\0`)
    if (!f.fileHash) {
      for (const line of f.hunks.flatMap((x) => x.lines)) h.update(`${line.kind}\0${line.text}\0`)
    }
  }
  return `dirty:${h.digest('hex')}`
}

/** Assemble the renderer-facing review (git diff, worktree band, artifacts, commits,
 *  drift tagging, comment re-anchoring) from a session + its `ReviewState`. Shared by
 *  the persisted load (`buildLoadedReview`, persist:true) and the transient preview
 *  (`previewReview`, persist:false). With `persist` false, no DB write happens — the
 *  artifact cache, viewed-drop cleanup, and re-anchor persistence are all skipped (the
 *  empty transient state makes the latter two no-ops anyway; we gate them explicitly). */
export async function assembleReview(
  db: DatabaseSync, session: SessionMeta, state: ReviewState, { persist }: { persist: boolean }
): Promise<LoadedReview> {
  const { repo, pair } = session
  const baseEff = effectiveRef(pair.base)
  const compareEff = effectiveRef(pair.compare)

  // ref-missing guard: a deleted branch or GC'd sha must not crash the app
  for (const [side, eff, symbol] of [['base', baseEff, pair.base.symbol], ['compare', compareEff, pair.compare.symbol]] as const) {
    try {
      await headSha(repo, eff)
    } catch {
      return {
        sessionId: session.id, session, state,
        baseContext: await describeSide(repo, pair.base),
        compareContext: await describeSide(repo, pair.compare),
        baseLoc: await locateSide(repo, pair.base),
        compareLoc: await locateSide(repo, pair.compare),
        skeleton: { base: baseEff, branch: compareEff, mergeBase: '', headSha: '', files: [] },
        branchHash: '',
        artifacts: [], commits: [], sinceTagged: false, dirty: false, volatile: [],
        writeCapability: await writeCapabilityFor(repo, pair.compare),
        refMissing: { side, symbol }
      }
    }
  }

  const skeleton = await getDiff(repo, baseEff, compareEff)
  // The worktree currently holding the compare branch (primary or a linked one);
  // working-tree reads (volatile band, artifact file contents) come from there.
  const wt = pair.compare.kind === 'branch' ? await branchCheckedOutAt(repo, pair.compare.symbol) : null
  const workdir = wt ?? repo
  // Volatile band: uncommitted changes (HEAD → working tree) of that worktree.
  // When the branch is checked out nowhere, there's no working tree for it.
  let dirty = false
  let volatile: FileDiff[] = []
  if (wt) {
    try {
      if (await isDirty(wt)) { dirty = true; volatile = await workingTreeDiff(wt) }
    } catch { /* status/diff failure — treat as clean */ }
  }
  const artifacts = await loadArtifactsFor(db, session.id, workdir, compareEff, state.artifacts, skeleton.files.map((f) => f.path), persist)
  const commits = await log(repo, baseEff, compareEff)
  const candidatePositions = new Map<string, number>()
  candidatePositions.set(skeleton.headSha, 0)
  for (let i = 0; i < commits.length; i++) {
    if (!candidatePositions.has(commits[i].sha)) candidatePositions.set(commits[i].sha, i)
  }
  const copyCandidates = dao.reviewCopyCandidates(db, repo, session.id, pair.base.anchorSha, candidatePositions).slice(0, 3)
  let sinceTagged = false
  const approvedShas = state.approvedShas ?? (state.approvedSha ? [state.approvedSha] : [])
  const baseline = approvedShas.includes(skeleton.headSha) ? skeleton.headSha : state.approvedSha ?? state.reviewedAtSha
  if (baseline && baseline !== skeleton.headSha) {
    try {
      const since = await diffSince(repo, baseline, compareEff)
      markSince(skeleton, since, 'since')
      attachSinceHunks(skeleton.files, since.files, 'sinceHunks')
      sinceTagged = true
    } catch { /* baseline unreachable (rebase) — full diff without drift */ }
  }
  const byViewSha = new Map<string, Set<string>>()
  for (const [file, mark] of Object.entries(state.viewedAt)) {
    if (mark.sha === skeleton.headSha) continue
    byViewSha.set(mark.sha, (byViewSha.get(mark.sha) ?? new Set()).add(file))
  }
  let viewedDropped = false
  for (const [sha, paths] of byViewSha) {
    try {
      const since = await diffSince(repo, sha, compareEff)
      markSince(skeleton, since, 'sinceViewed', paths)
      attachSinceHunks(skeleton.files, since.files, 'sinceViewedHunks', paths)
    } catch {
      for (const p of paths) { delete state.viewedAt[p]; viewedDropped = true }
    }
  }
  if (viewedDropped && persist) dao.replaceUiState(db, session.id, { viewedAt: state.viewedAt })
  // Merged base→working-tree view (only when dirty): one diff per file with each
  // line attributed to the committed or uncommitted delta. The same drift rails are
  // carried over, but computed in worktree space (the merged diff's new-side line
  // numbers) so "Since approved/viewed" keeps working while the tree is dirty.
  let merged: FileDiff[] | undefined
  if (dirty && wt) {
    try {
      merged = await mergedWorkingDiff(wt, baseEff, compareEff)
      const asSkel = (files: FileDiff[]): DiffSkeleton => ({ ...skeleton, files })
      // A since-diff that equals the file's full diff adds nothing — e.g. an untracked
      // working-tree file is wholly new at the baseline too. Tag only files whose delta
      // since the baseline is narrower than the full diff, so we don't slap a redundant
      // (and, for untracked files, misleading) "since approved/viewed" badge on them.
      const fullByPath = new Map(merged.map((f) => [f.path, f]))
      const narrowerThanFull = (sinceFiles: FileDiff[], within?: Set<string>): Set<string> => {
        const out = new Set<string>()
        for (const sf of sinceFiles) {
          if (within && !within.has(sf.path)) continue
          const full = fullByPath.get(sf.path)
          if (full && (sf.add !== full.add || sf.del !== full.del)) out.add(sf.path)
        }
        return out
      }
      if (baseline) {
        try {
          const sinceW = await diffSinceWorking(wt, baseline)
          const paths = narrowerThanFull(sinceW)
          markSince(asSkel(merged), asSkel(sinceW), 'since', paths)
          attachSinceHunks(merged, sinceW, 'sinceHunks', paths)
        } catch { /* baseline unreachable */ }
      }
      for (const [sha, paths] of byViewSha) {
        try {
          const sinceW = await diffSinceWorking(wt, sha)
          const within = narrowerThanFull(sinceW, paths)
          markSince(asSkel(merged), asSkel(sinceW), 'sinceViewed', within)
          attachSinceHunks(merged, sinceW, 'sinceViewedHunks', within)
        } catch { /* view sha unreachable */ }
      }
    } catch { merged = undefined /* fall back to skeleton + volatile band */ }
  }
  // Attach the current on-disk content hash to every rendered file (whenever a working
  // tree exists, dirty or not) so marking a file viewed snapshots it — a later
  // uncommitted edit then re-flags the file even with no commit movement.
  if (wt) {
    try {
      const paths = new Set([...skeleton.files, ...(merged ?? []), ...volatile].map((f) => f.path))
      const hashes = await hashObjects(wt, [...paths])
      for (const f of [...skeleton.files, ...(merged ?? []), ...volatile]) {
        const h = hashes.get(f.path)
        if (h) f.fileHash = h
      }
    } catch { /* hashing failed — viewed falls back to commit-only detection */ }
  }
  // Excluded untracked files carry no review state — they must not move the branch
  // surface hash (which gates "still approved"), or hiding a scratch file would
  // silently un-approve the review. Drop them before hashing.
  const annotated = Boolean(state.annotations)
  const sectionedPaths = new Set((state.annotations?.sections ?? []).flatMap((s) => s.files))
  const hashVolatile = dirty
    ? volatile.filter((f) => !fileEffectivelyExcluded(f, state.fileExcluded, annotated, !sectionedPaths.has(f.path)))
    : []
  const branchHash = branchSurfaceHash(skeleton.headSha, hashVolatile)
  // Re-anchor against the surface that is actually rendered. When dirty that's the
  // merged base→working-tree diff (committed + uncommitted lines in worktree-space
  // line numbers), so comments on committed lines line up even when dirty edits above
  // shift their numbers. lineContent is the durable key; the line number is only a
  // pickNearest hint and is re-derived each load — approval/viewed never read it — so
  // persisting worktree-space hints is safe and self-corrects once the tree is clean.
  // Falls back to skeleton (+ volatile band) when no merged diff was produced.
  const forAnchor = merged
    ? { ...skeleton, files: merged }
    : volatile.length
    ? { ...skeleton, files: mergeFilesByPath(skeleton.files, volatile) }
    : skeleton
  reanchorComments(state.comments, forAnchor, artifacts)
  if (persist) for (const c of state.comments) dao.upsertComment(db, session.id, c) // persist re-anchoring
  const writeCapability = await writeCapabilityFor(repo, pair.compare)
  return {
    sessionId: session.id, session,
    baseContext: await describeSide(repo, pair.base),
    compareContext: await describeSide(repo, pair.compare),
    baseLoc: await locateSide(repo, pair.base),
    compareLoc: await locateSide(repo, pair.compare),
    skeleton, branchHash, state, artifacts, commits, sinceTagged, dirty, volatile, merged,
    copyCandidates,
    // compare branch is checked out in some worktree (primary or linked); null for
    // non-branch compares. Gates the agent (writes can't land when checked out nowhere).
    writeCapability
  }
}

/** Load a persisted session into a renderer-facing review (with DB-side reconciliation
 *  + writes). */
export async function buildLoadedReview(db: DatabaseSync, session: SessionMeta): Promise<LoadedReview> {
  const state = dao.loadReviewState(db, session.id)
  return assembleReview(db, session, state, { persist: true })
}

/** An empty in-memory `ReviewState` for a not-yet-persisted (transient) review. */
function emptyReviewState(repo: string, pair: RefPair, agent: AgentRef): ReviewState {
  return {
    repo,
    branch: effectiveRef(pair.compare),
    base: effectiveRef(pair.base),
    engine: agent.engine,
    agent,
    annotations: undefined,
    comments: [], chats: [],
    viewedAt: {}, reviewedSections: [], fileExcluded: {},
    artifactApprovals: {}, iterations: [], artifacts: []
  }
}

/** Build a review for an arbitrary ref pair WITHOUT minting a session — the default
 *  entry. Resolves the refs (throws on an unresolvable one), synthesizes a sentinel
 *  session (id 0) + an empty state, and runs the same diff/worktree/artifact assembly
 *  as the persisted path with all DB writes suppressed. The store persists on first
 *  write (materialize). */
export async function previewReview(
  db: DatabaseSync, repo: string, baseInput: string, compareInput: string, agent: AgentRef
): Promise<LoadedReview> {
  const base = await resolveRefInput(repo, baseInput)
  const compare = await resolveRefInput(repo, compareInput)
  const pair: RefPair = {
    base: { kind: base.kind, symbol: base.symbol, anchorSha: base.sha },
    compare: { kind: compare.kind, symbol: compare.symbol, anchorSha: compare.sha }
  }
  const t = new Date().toISOString()
  const session: SessionMeta = { id: 0, repo, pair, engine: agent.engine, agent, createdAt: t, updatedAt: t }
  return assembleReview(db, session, emptyReviewState(repo, pair, agent), { persist: false })
}
