import type { DatabaseSync } from 'node:sqlite'
import type { LoadedReview } from '../shared/ipc.js'
import type { AgentRef, Artifact, FileDiff, RefPair, ReviewState, SessionMeta } from '../shared/types.js'
import { effectiveRef } from '../shared/types.js'
import {
  branchCheckedOutAt, describeSide, diffSince, getDiff, headSha, isDirty, locateSide, log, markSince,
  resolveRefInput, workingTreeDiff
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
        artifacts: [], commits: [], sinceTagged: false, dirty: false, volatile: [], compareCheckedOut: false,
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
  let sinceTagged = false
  const baseline = state.approvedSha ?? state.reviewedAtSha
  if (baseline && baseline !== skeleton.headSha) {
    try {
      const since = await diffSince(repo, baseline, compareEff)
      markSince(skeleton, since, 'since')
      sinceTagged = true
    } catch { /* baseline unreachable (rebase) — full diff without drift */ }
  }
  const byViewSha = new Map<string, Set<string>>()
  for (const [file, sha] of Object.entries(state.viewedAt)) {
    if (sha === skeleton.headSha) continue
    byViewSha.set(sha, (byViewSha.get(sha) ?? new Set()).add(file))
  }
  let viewedDropped = false
  for (const [sha, paths] of byViewSha) {
    try {
      const since = await diffSince(repo, sha, compareEff)
      markSince(skeleton, since, 'sinceViewed', paths)
    } catch {
      for (const p of paths) { delete state.viewedAt[p]; viewedDropped = true }
    }
  }
  if (viewedDropped && persist) dao.replaceUiState(db, session.id, { viewedAt: state.viewedAt })
  // Re-anchor against the spine PLUS the volatile band: a comment on an
  // uncommitted line stays anchored while volatile, and auto-pins once the change
  // is committed (the line migrates from `volatile` into `skeleton`).
  const forAnchor = volatile.length
    ? { ...skeleton, files: mergeFilesByPath(skeleton.files, volatile) }
    : skeleton
  reanchorComments(state.comments, forAnchor, artifacts)
  if (persist) for (const c of state.comments) dao.upsertComment(db, session.id, c) // persist re-anchoring
  return {
    sessionId: session.id, session,
    baseContext: await describeSide(repo, pair.base),
    compareContext: await describeSide(repo, pair.compare),
    baseLoc: await locateSide(repo, pair.base),
    compareLoc: await locateSide(repo, pair.compare),
    skeleton, state, artifacts, commits, sinceTagged, dirty, volatile,
    // compare branch is checked out in some worktree (primary or linked); null for
    // non-branch compares. Gates the agent (writes can't land when checked out nowhere).
    compareCheckedOut: wt != null
  }
}

/** Load a persisted session into a renderer-facing review (with DB-side reconciliation
 *  + writes). */
export async function buildLoadedReview(db: DatabaseSync, session: SessionMeta): Promise<LoadedReview> {
  dao.reconcileChats(db, session.id) // ensure default chats exist + review chat tracks latest iteration
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
    viewedAt: {}, reviewedSections: [],
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
