import type { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import type { LoadedReview } from '../shared/ipc.js'
import type { AgentRef, AgentWriteCapability, Artifact, ArtifactRef, DiffSkeleton, FileDiff, RefPair, RefSide, ReviewState, SessionMeta } from '../shared/types.js'
import { effectiveRef, fileEffectivelyExcluded } from '../shared/types.js'
import { approvedShaList, commitBaselines, sinceBasis } from '../shared/sinceBasis.js'
import {
  attachBaseHunks, attachSinceHunks, branchCheckedOutAt, commitExists, describeSide, diffRefs, diffSince, diffSinceWorking, getDiff, hashObjects, headSha, isAncestor, isDirty, locateSide,
  log, markSince, mergedWorkingDiff, resolveRefInput, workingTreeDiff
} from './git.js'
import * as dao from './db/sessions.js'
import { detectArtifacts, loadArtifact } from './artifacts.js'
import { createReanchorPass, reanchorComments, reanchorFocusTargets, reviewFocusTargets } from './anchor.js'

/** The review's spec/plan rail: detection against the CURRENT diff, reconciled with
 *  what the session cached. Detected rows follow the diff — a rebase, squash or
 *  dropped commit that takes a spec out of the diff takes it off the rail. Cached
 *  rows the agent reported, the reviewer approved, or that carry comments stay:
 *  dropping them would strand an approval or a comment thread. When `persist` is
 *  true the reconciled list replaces the cache (only if it changed); the transient
 *  (preview) path passes false to stay write-free. */
export async function loadArtifactsFor(
  db: DatabaseSync, sessionId: number, repo: string, branch: string,
  state: Pick<ReviewState, 'artifacts' | 'artifactApprovals' | 'comments'>, changedPaths: string[], persist = true
): Promise<Artifact[]> {
  const detected: ArtifactRef[] = (await detectArtifacts(repo, branch, changedPaths)).map((d) => ({ role: d.role, path: d.path, source: 'detected' }))
  const commented = new Set(state.comments.map((c) => c.anchor).filter((a) => a.kind === 'artifact').map((a) => a.path))
  const kept = state.artifacts.filter((a) =>
    !detected.some((d) => d.path === a.path) && (a.source === 'agent' || a.path in state.artifactApprovals || commented.has(a.path)))
  const refs = [...detected, ...kept]
  const same = refs.length === state.artifacts.length && refs.every((r, i) => {
    const c = state.artifacts[i]
    return c.path === r.path && c.role === r.role && c.source === r.source
  })
  if (persist && !same) dao.setArtifacts(db, sessionId, refs)
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
  // A dirty tree no longer blocks: reviewer in-place edits and agent writes share the
  // working tree deliberately (specs/inplace-edits, invariant 8); CAS + git history
  // arbitrate, and the UI keeps an "edits will mix" warn.
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
        artifacts: [], commits: [], dirty: false, volatile: [],
        writeCapability: await writeCapabilityFor(repo, pair.compare),
        refMissing: { side, symbol },
        activeOps: []
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
  const artifacts = await loadArtifactsFor(db, session.id, workdir, compareEff, state, skeleton.files.map((f) => f.path), persist)
  const commits = await log(repo, baseEff, compareEff)
  const candidatePositions = new Map<string, number>()
  candidatePositions.set(skeleton.headSha, 0)
  for (let i = 0; i < commits.length; i++) {
    if (!candidatePositions.has(commits[i].sha)) candidatePositions.set(commits[i].sha, i)
  }
  const copyCandidates = dao.reviewCopyCandidates(db, repo, session.id, pair.base.anchorSha, candidatePositions).slice(0, 3)
  // The reader can switch a file to either commit baseline (see commitBaselines), so
  // each gets its own slice. The RAIL, though, stays single — one amber hatch means
  // "moved since your latest checkpoint" (the approval if there is one, else the sha
  // the review was generated at); a rail per baseline is the density that made the
  // marks unreadable. src/shared/sinceBasis.ts owns both rules.
  const railSha = sinceBasis(state, skeleton.headSha)?.sha
  const baselines = commitBaselines(state, skeleton.headSha)
  const HUNK_KEY = { review: 'sinceReviewHunks', approved: 'sinceHunks' } as const
  // …and the base→checkpoint slice beside each checkpoint→now one: the Multi
  // layout's middle column, aligned on base line numbers like `hunks` itself.
  const BASE_KEY = { review: 'baseToReviewHunks', approved: 'baseToApprovedHunks' } as const
  // `git diff <mergeBase> <sha>` is a pure two-sha diff that never reads the working
  // tree, and the committed pass below and the merged/dirty pass further down ask for
  // exactly the same pairs — so each pair costs one subprocess per load, not two.
  // The memo is keyed by the checkout as well as the sha, though: git resolves diff
  // attributes from the working tree it runs in, so a linked worktree whose
  // .gitattributes differs from the primary checkout's can legitimately render the
  // same pair differently (`-diff` there turns a text diff into "Binary files differ").
  // `repo` (the session's stored path) and `wt` (a real path out of `git worktree
  // list`) are resolved once here, so the usual single-checkout case — where the two
  // spellings name one directory — shares one entry.
  // Both surfaces then hold the SAME FileDiff arrays by reference (attachBaseHunks
  // assigns the diff's own `hunks`): the base→checkpoint slices are read-only from
  // here on, and anything that needs to mutate one must copy it first.
  const realDir = (dir: string): string => {
    try { return fs.realpathSync(dir) } catch { return dir }
  }
  const dirKeys = new Map<string, string>([[repo, realDir(repo)]])
  if (wt) dirKeys.set(wt, realDir(wt))
  const baseSlices = new Map<string, FileDiff[]>()
  const baseToCheckpoint = async (dir: string, sha: string): Promise<FileDiff[]> => {
    const key = `${dirKeys.get(dir) ?? dir}\0${sha}`
    let slice = baseSlices.get(key)
    if (!slice) {
      slice = await diffRefs(dir, skeleton.mergeBase, sha)
      baseSlices.set(key, slice)
    }
    return slice
  }
  for (const b of baselines) {
    try {
      const since = await diffSince(repo, b.sha, compareEff)
      if (b.sha === railSha) markSince(skeleton, since, 'since')
      attachSinceHunks(skeleton.files, since.files, HUNK_KEY[b.mode])
      attachBaseHunks(skeleton.files, await baseToCheckpoint(repo, b.sha), BASE_KEY[b.mode])
    } catch { /* baseline unreachable (rebase) — full diff without drift */ }
  }
  const byViewSha = new Map<string, Set<string>>()
  for (const [file, mark] of Object.entries(state.viewedAt)) {
    if (mark.sha === skeleton.headSha) continue
    byViewSha.set(mark.sha, (byViewSha.get(mark.sha) ?? new Set()).add(file))
  }
  let viewedDropped = false
  for (const [sha, paths] of byViewSha) {
    // Dropping a file's Viewed tick is durable and silent (replaceUiState below is a
    // DELETE-then-reinsert with no undo), so only a *proved* unreachable checkpoint —
    // rebased away or GC'd, its marks now meaningless — may trigger it. A git call
    // that merely failed (a huge diff, spawn EAGAIN, exec's 64 MB maxBuffer) says
    // nothing about the sha: skip this load's decoration and keep the ticks, exactly
    // as the baselines loop above does.
    if (!(await commitExists(repo, sha))) {
      // The probe is a git call too, and exec.ts throws a message-only Error, so a
      // false can equally mean "git could not run here at all". Ask it about a sha we
      // know exists before believing the verdict; if even that comes back false the
      // probe is broken, not the checkpoint, and the ticks stay.
      if (await commitExists(repo, skeleton.headSha)) {
        for (const p of paths) { delete state.viewedAt[p]; viewedDropped = true }
      }
      continue
    }
    try {
      const since = await diffSince(repo, sha, compareEff)
      markSince(skeleton, since, 'sinceViewed', paths)
      attachSinceHunks(skeleton.files, since.files, 'sinceViewedHunks', paths)
      attachBaseHunks(skeleton.files, await baseToCheckpoint(repo, sha), 'baseToViewedHunks', paths)
    } catch { /* decoration failed for this load — the marks stay */ }
  }
  if (viewedDropped && persist) dao.replaceUiState(db, session.id, { viewedAt: state.viewedAt })
  // Merged base→working-tree view (only when dirty): one diff per file with each
  // line attributed to the committed or uncommitted delta. The same drift rails are
  // carried over, but computed in worktree space (the merged diff's new-side line
  // numbers) so "Since approved/viewed" keeps working while the tree is dirty.
  let merged: FileDiff[] | undefined
  if (dirty && wt) {
    try {
      merged = await mergedWorkingDiff(wt, baseEff, compareEff, volatile)
      const asSkel = (files: FileDiff[]): DiffSkeleton => ({ ...skeleton, files })
      // Since-tag every file uniformly — a "changed since approved/viewed" rail always
      // means "this line changed since that baseline", even for a wholly-new (untracked)
      // file whose since-diff equals its full diff. The renderer decides how to present a
      // wholly-new file (diffHunksForMode); the data layer no longer suppresses it here.
      // includeHead: approved AT this commit and then edited — the uncommitted delta
      // is the whole point of the "since approved" window while dirty
      for (const b of commitBaselines(state, skeleton.headSha, { includeHead: true })) {
        try {
          const sinceW = await diffSinceWorking(wt, b.sha)
          if (b.sha === railSha) markSince(asSkel(merged), asSkel(sinceW), 'since')
          attachSinceHunks(merged, sinceW, HUNK_KEY[b.mode])
          attachBaseHunks(merged, await baseToCheckpoint(wt, b.sha), BASE_KEY[b.mode])
        } catch { /* baseline unreachable */ }
      }
      for (const [sha, paths] of byViewSha) {
        try {
          const sinceW = await diffSinceWorking(wt, sha)
          markSince(asSkel(merged), asSkel(sinceW), 'sinceViewed', paths)
          attachSinceHunks(merged, sinceW, 'sinceViewedHunks', paths)
          attachBaseHunks(merged, await baseToCheckpoint(wt, sha), 'baseToViewedHunks', paths)
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
  const reanchorCtx = { workdir, hasWorktree: wt !== null, forAnchor, currentTip: skeleton.headSha, currentMergeBase: skeleton.mergeBase, session }
  // One pass for every anchor family in the review, so they share its per-load git
  // memos (a second pass would re-probe every blob and re-run every diff).
  const pass = createReanchorPass(reanchorCtx, artifacts)
  await reanchorComments(reanchorCtx, state.comments, artifacts, pass)
  // #18 (narration scope): narration blocks, diagram nodes and frozen `point` stops
  // carry bare FocusTargets with no owning comment. They are stamped at creation and
  // re-anchored here through the SAME pipeline — the verdict rides on the anchor
  // (`stale`) and is recomputed from the immutable stamp every load, so unlike
  // comments it needs no write-back.
  await reanchorFocusTargets(pass, reviewFocusTargets(state))
  if (persist) for (const c of state.comments) dao.upsertComment(db, session.id, c) // persist re-anchoring
  const writeCapability = await writeCapabilityFor(repo, pair.compare)
  // S12 "merged outside Limn": the approved tip is already reachable from the base
  // head of a live branch/branch session. Piggybacks on state loads — never the
  // watcher hot path. External squash-merges are not detectable by ancestry (out of
  // scope); best-effort: an unreadable base yields no detection, never a throw.
  let mergedExternally = false
  if (!state.merged && pair.base.kind === 'branch' && pair.compare.kind === 'branch') {
    try {
      const baseHead = await headSha(repo, pair.base.symbol)
      mergedExternally = approvedShaList(state).includes(skeleton.headSha)
        && await isAncestor(repo, skeleton.headSha, baseHead)
    } catch { /* base unreadable — no detection */ }
  }
  return {
    sessionId: session.id, session,
    baseContext: await describeSide(repo, pair.base),
    compareContext: await describeSide(repo, pair.compare),
    baseLoc: await locateSide(repo, pair.base),
    compareLoc: await locateSide(repo, pair.compare),
    skeleton, branchHash, state, artifacts, commits, dirty, volatile, merged,
    copyCandidates,
    // compare branch is checked out in some worktree (primary or linked); null for
    // non-branch compares. Gates the agent (writes can't land when checked out nowhere).
    writeCapability,
    // `loadSession` populates this from the live-op registry after this returns
    // (a transient preview never has ops, so it stays empty there).
    activeOps: [],
    ...(mergedExternally ? { mergedExternally: true } : {})
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
    agent,
    annotations: undefined,
    comments: [], chats: [],
    viewedAt: {}, fileExcluded: {},
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
  const session: SessionMeta = { id: 0, repo, pair, agent, createdAt: t, updatedAt: t }
  return assembleReview(db, session, emptyReviewState(repo, pair, agent), { persist: false })
}
