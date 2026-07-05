import type { DatabaseSync } from 'node:sqlite'
import type {
  DependentReview, MergeCleanupRequest, MergeExecuteRequest, MergeExecuteResult, MergeGate,
  MergeGateId, MergeOverride, MergePreflight, MergeRecord, MergeStrategy, ReviewState, SessionMeta
} from '../shared/types.js'
import {
  aheadCount, branchCheckedOutAt, commitTree, deleteBranch, dirtyCount, driftSummary,
  EMPTY_TREE, headSha, isAncestor, isDirty, log, mergeBase, mergeInWorktree, mergeTreeProbe,
  rebaseOnto, removeWorktree, setRef, updateRefCas, type MergeProbe
} from './git.js'
import * as dao from './db/sessions.js'

/** Inputs the gate evaluator is pure over — gathered from git + db by
 *  `gatherMergePreflight` (Task 8), synthesized directly in unit tests. */
export interface MergeGateInputs {
  /** approvalFresh over the session's approved shas vs the current tip. */
  approvalCoversTip: boolean
  /** commit/line delta since the latest approved sha; absent when there is no
   *  approved sha to count from (never-approved review, or unreachable after rebase). */
  staleInfo?: { commits: number; add: number; del: number; sinceSha: string }
  /** compare branch's worktree has uncommitted changes (red — merges land commits). */
  branchDirty?: { workdir: string; count: number }
  /** base branch is checked out somewhere and that worktree is dirty (red, G3). */
  baseSiteDirty?: { workdir: string; count: number }
  /** base head ≠ merge-base(base, branch) (amber, G2). */
  baseMoved?: { commits: number; from: string; to: string }
  probe: MergeProbe
  /** isAncestor(baseHead, tipSha) — fast-forward is mechanically possible. */
  ffPossible: boolean
}

function plural(n: number): string {
  return n === 1 ? '' : 's'
}

/** Pure gate evaluation (spec §3). Bands come out red → amber → info, the order the
 *  sheet renders them in. */
export function evaluateMergeGates(i: MergeGateInputs): MergeGate[] {
  const gates: MergeGate[] = []
  if (i.probe.status === 'conflict') {
    const n = i.probe.conflictFiles.length
    gates.push({
      id: 'conflicts', severity: 'red',
      detail: `Merging would conflict in ${n} file${plural(n)}`,
      files: i.probe.conflictFiles
    })
  }
  if (i.baseSiteDirty) {
    gates.push({
      id: 'base-site-dirty', severity: 'red',
      detail: `The base branch's worktree has ${i.baseSiteDirty.count} uncommitted change${plural(i.baseSiteDirty.count)} (${i.baseSiteDirty.workdir})`,
      workdir: i.baseSiteDirty.workdir
    })
  }
  if (i.branchDirty) {
    gates.push({
      id: 'branch-dirty', severity: 'red',
      detail: `The branch worktree has ${i.branchDirty.count} uncommitted change${plural(i.branchDirty.count)} (${i.branchDirty.workdir})`,
      workdir: i.branchDirty.workdir
    })
  }
  if (!i.approvalCoversTip) {
    const s = i.staleInfo
    gates.push({
      id: 'stale-approval', severity: 'amber',
      detail: s
        ? `${s.commits} commit${plural(s.commits)} since approval ${s.sinceSha.slice(0, 7)} (+${s.add} / −${s.del})`
        : 'The approval does not cover the current tip',
      ...(s ? { commits: s.commits, add: s.add, del: s.del } : {})
    })
  }
  if (i.baseMoved) {
    gates.push({
      id: 'base-moved', severity: 'amber',
      detail: `The base has moved: ${i.baseMoved.commits} new commit${plural(i.baseMoved.commits)} since the reviewed merge-base`,
      commits: i.baseMoved.commits
    })
  }
  if (i.probe.status === 'unavailable') {
    gates.push({
      id: 'probe-unavailable', severity: 'info',
      detail: 'Conflict probe unavailable (git < 2.38) — conflicts are checked at confirm time'
    })
  }
  return gates
}

/** The CTA verdict: no red gates (never overridable), every amber acked in
 *  `overrides`, info gates never block. */
export function mergeOk(gates: MergeGate[], overrides: MergeGateId[]): boolean {
  return gates.every((g) =>
    g.severity === 'info' || (g.severity === 'amber' && overrides.includes(g.id)))
}

/** MECHANICAL availability only (what the picker can offer): ff iff the base head is
 *  an ancestor of the tip; squash/merge iff the probe did not find conflicts (an
 *  unavailable probe keeps them offered — conflicts surface at confirm on old git).
 *  Whether the CTA is enabled is `mergeOk`'s call, never this matrix's. */
export function strategyAvailability(i: MergeGateInputs): Record<MergeStrategy, boolean> {
  const mergeable = i.probe.status !== 'conflict'
  return { ff: i.ffPossible, squash: mergeable, merge: mergeable }
}

const WRAP_COL = 72

/** Greedy word-wrap at 72 columns, per line. Words longer than the column stand alone. */
function wrap72(text: string): string {
  return text.split('\n').map((line) => {
    if (line.length <= WRAP_COL) return line
    const out: string[] = []
    let cur = ''
    for (const word of line.split(' ')) {
      if (cur && cur.length + 1 + word.length > WRAP_COL) {
        out.push(cur)
        cur = word
      } else {
        cur = cur ? `${cur} ${word}` : word
      }
    }
    if (cur) out.push(cur)
    return out.join('\n')
  }).join('\n')
}

/** The spec §3 draft template — a template over the existing narration, no model call:
 *
 *      <title>
 *
 *      <summary, wrapped at 72>
 *
 *      Reviewed-with: Limn (approved <tip7>, base <baseSymbol> @ <baseAnchor7>)
 */
export function draftMergeMessage(title: string, summary: string, tip7: string, baseSymbol: string, baseAnchor7: string): string {
  const trailer = `Reviewed-with: Limn (approved ${tip7}, base ${baseSymbol} @ ${baseAnchor7})`
  const body = summary.trim() ? `${wrap72(summary.trim())}\n\n` : ''
  return `${title.trim()}\n\n${body}${trailer}`
}

/** Everything one preflight/execute pass needs, gathered once from git + db. The
 *  execute path re-gathers this inside the exclusive lane (authoritative re-check). */
interface MergeContext {
  session: SessionMeta
  state: ReviewState
  repo: string
  baseSymbol: string
  branch: string
  baseHead: string
  tipSha: string
  inputs: MergeGateInputs
  commits: { sha: string; subject: string }[]
  counts: { commits: number; files: number; add: number; del: number }
  /** the compare branch's worktree (primary or linked), if checked out anywhere */
  worktreePath: string | null
  /** the BASE branch's worktree — non-null selects the in-worktree strategy path */
  baseWorkdir: string | null
  dependents: DependentReview[]
  draftMessage: string
}

async function gatherContext(db: DatabaseSync, sessionId: number): Promise<MergeContext> {
  const session = dao.getSession(db, sessionId)
  if (!session) throw new Error(`session ${sessionId} not found`)
  const { repo, pair } = session
  // S9: merges land branches on branches — every other pair never shows the button,
  // and the handler backstops it here.
  if (pair.base.kind !== 'branch' || pair.compare.kind !== 'branch') {
    throw new Error('Merge requires a branch base and a branch compare')
  }
  const state = dao.loadReviewState(db, sessionId)
  if (state.merged) throw new Error('This review is already merged')
  const baseSymbol = pair.base.symbol
  const branch = pair.compare.symbol
  const baseHead = await headSha(repo, baseSymbol)
  const tipSha = await headSha(repo, branch)
  const mb = await mergeBase(repo, baseSymbol, branch).catch(() => EMPTY_TREE)

  // approval gate: the committed tip must be explicitly approved. Dirty-surface
  // approvals don't count here — a merge can only land commits (branch-dirty is
  // its own red gate).
  const approvedShas = state.approvedShas ?? (state.approvedSha ? [state.approvedSha] : [])
  const approvalCoversTip = approvedShas.includes(tipSha)
  let staleInfo: MergeGateInputs['staleInfo']
  if (!approvalCoversTip && state.approvedSha) {
    try {
      const d = await driftSummary(repo, branch, state.approvedSha, null) // committed-only
      staleInfo = { commits: d.commits, add: d.add, del: d.del, sinceSha: state.approvedSha }
    } catch { /* approved sha unreachable (rebase) — stale gate without counts */ }
  }

  const worktreePath = await branchCheckedOutAt(repo, branch)
  const branchDirty = worktreePath && await isDirty(worktreePath)
    ? { workdir: worktreePath, count: await dirtyCount(worktreePath) }
    : undefined
  const baseWorkdir = await branchCheckedOutAt(repo, baseSymbol)
  const baseSiteDirty = baseWorkdir && await isDirty(baseWorkdir)
    ? { workdir: baseWorkdir, count: await dirtyCount(baseWorkdir) }
    : undefined
  const baseMoved = baseHead !== mb
    ? { commits: await aheadCount(repo, mb, baseSymbol), from: mb, to: baseHead }
    : undefined
  const probe = await mergeTreeProbe(repo, baseSymbol, branch)
  const ffPossible = await isAncestor(repo, baseHead, tipSha)

  const commitList = await log(repo, baseSymbol, branch) // base..tip, newest first
  const range = await driftSummary(repo, branch, mb, null)
  const counts = { commits: commitList.length, files: range.files, add: range.add, del: range.del }

  const dependents: DependentReview[] = []
  for (const dep of dao.dependentSessions(db, repo, branch)) {
    const wt = await branchCheckedOutAt(repo, dep.branch)
    const clean = wt ? !(await isDirty(wt)) : false
    dependents.push({
      sessionId: dep.sessionId,
      branch: dep.branch,
      commits: await aheadCount(repo, branch, dep.branch),
      rebasable: Boolean(wt) && clean,
      ...(wt ? (clean ? {} : { blockedReason: 'dirty worktree' }) : { blockedReason: 'not checked out' })
    })
  }

  const title = state.annotations?.title?.trim() || `Merge ${branch} into ${baseSymbol}`
  const draftMessage = draftMergeMessage(
    title, state.annotations?.summary ?? '', tipSha.slice(0, 7), baseSymbol, baseHead.slice(0, 7))

  return {
    session, state, repo, baseSymbol, branch, baseHead, tipSha,
    inputs: { approvalCoversTip, staleInfo, branchDirty, baseSiteDirty, baseMoved, probe, ffPossible },
    commits: commitList.map((c) => ({ sha: c.sha, subject: c.subject })),
    counts, worktreePath, baseWorkdir, dependents, draftMessage
  }
}

function toPreflight(ctx: MergeContext, gates: MergeGate[]): MergePreflight {
  return {
    ok: mergeOk(gates, []),
    gates,
    strategies: strategyAvailability(ctx.inputs),
    commits: ctx.commits,
    draftMessage: ctx.draftMessage,
    counts: ctx.counts,
    baseHead: ctx.baseHead,
    tipSha: ctx.tipSha,
    baseSymbol: ctx.baseSymbol,
    branch: ctx.branch,
    cleanup: {
      ...(ctx.worktreePath ? { worktreePath: ctx.worktreePath } : {}),
      dependents: ctx.dependents
    }
  }
}

/** Spec §3: the read-only preflight — gates, strategy matrix, commit list, draft
 *  message, CAS expectations. No lane, no writes; callable anytime like loadSession. */
export async function gatherMergePreflight(db: DatabaseSync, sessionId: number): Promise<MergePreflight> {
  const ctx = await gatherContext(db, sessionId)
  return toPreflight(ctx, evaluateMergeGates(ctx.inputs))
}

function errorMessage(error: unknown): string {
  return String(error instanceof Error ? error.message : error)
}

/** Run writes in one transaction (mirrors ipc.ts's inTx — node:sqlite has no
 *  db.transaction()). Not re-entrant: `fn` must not open its own transaction. */
function inTx(db: DatabaseSync, fn: () => void): void {
  db.exec('BEGIN')
  try {
    fn()
    db.exec('COMMIT')
  } catch (err) {
    try { db.exec('ROLLBACK') } catch { /* no active txn — keep original error */ }
    throw err
  }
}

function emptyCleanup(): MergeRecord['cleanup'] {
  return { archived: false, branchDeleted: false, worktreeRemoved: false, retargeted: [], failures: [] }
}

/** Post-land cleanup + dependent retargets (spec §4 steps 4-5, §6b). Mutates
 *  `record.cleanup` in place; every failure is collected, never thrown — the merge
 *  record is already durable. Order matters: dependents first (branch-deletion skip
 *  reads who still bases on the branch), worktree removal before branch deletion
 *  (git refuses -D on a checked-out branch). */
async function runCleanupAndRetargets(
  db: DatabaseSync, ctx: MergeContext, record: MergeRecord,
  cleanup: MergeCleanupRequest, newBaseHead: string
): Promise<void> {
  for (const depId of cleanup.retarget) {
    const dep = ctx.dependents.find((d) => d.sessionId === depId)
    if (!dep) {
      record.cleanup.failures.push(`retarget ${depId}: no longer a dependent of ${ctx.branch}`)
      continue
    }
    try {
      // re-verify rebasability — the sheet may have sat open (spec §6b step 1)
      const wt = await branchCheckedOutAt(ctx.repo, dep.branch)
      if (!wt) { record.cleanup.failures.push(`retarget ${dep.branch}: not checked out`); continue }
      if (await isDirty(wt)) { record.cleanup.failures.push(`retarget ${dep.branch}: dirty worktree`); continue }
      // only the dependent's own commits replay: old stack point = the reviewed tip
      const res = await rebaseOnto(wt, newBaseHead, ctx.tipSha, dep.branch)
      if (!res.ok) { record.cleanup.failures.push(`retarget ${dep.branch}: ${res.error}`); continue }
      // rebase succeeded — only now repoint the session base (the one audited
      // exception to base immutability; public retargetSession keeps throwing)
      dao.retargetSessionBase(db, depId, { kind: 'branch', symbol: ctx.baseSymbol, anchorSha: newBaseHead })
      record.cleanup.retargeted.push(dep.branch)
    } catch (err) {
      record.cleanup.failures.push(`retarget ${dep.branch}: ${errorMessage(err)}`)
    }
  }
  if (cleanup.removeWorktree && ctx.worktreePath) {
    try {
      await removeWorktree(ctx.repo, ctx.worktreePath)
      record.cleanup.worktreeRemoved = ctx.worktreePath
    } catch (err) {
      record.cleanup.failures.push(`remove worktree: ${errorMessage(err)}`)
    }
  }
  if (cleanup.deleteBranch) {
    // refuse while any LIVE session still bases on the branch (dependents not
    // selected, not rebasable, or whose rebase failed) — deleting it would
    // refMissing every stacked review (spec §4 step 5). Any compare kind counts
    // here (unlike the retarget list above, which only lists branch-compare
    // dependents that can actually be rebased) — a commit-kind compare still
    // depends on the base branch ref existing, it just can't be retargeted.
    const stillBased = dao.sessionsBasedOn(db, ctx.repo, ctx.branch)
    if (stillBased.length > 0) {
      record.cleanup.failures.push(
        `delete branch skipped: ${stillBased.map((d) => d.branch).join(', ')} still base${stillBased.length === 1 ? 's' : ''} on ${ctx.branch}`)
    } else {
      try {
        await deleteBranch(ctx.repo, ctx.branch)
        record.cleanup.branchDeleted = true
      } catch (err) {
        record.cleanup.failures.push(`delete branch: ${errorMessage(err)}`)
      }
    }
  }
  if (cleanup.archiveSession) {
    try {
      dao.archiveSession(db, ctx.session.id)
      record.cleanup.archived = true
    } catch (err) {
      record.cleanup.failures.push(`archive: ${errorMessage(err)}`)
    }
  }
}

/** Plant the keep-ref and write record + compare retarget atomically — BEFORE any
 *  cleanup can delete the branch (spec §2 record durability). */
async function persistMergeRecord(db: DatabaseSync, ctx: MergeContext, record: MergeRecord): Promise<void> {
  await setRef(ctx.repo, `refs/limn/keep/${ctx.session.id}`, ctx.tipSha)
  const base = ctx.session.pair.base
  inTx(db, () => {
    dao.markSessionMerged(db, ctx.session.id, record)
    // symbol keeps the BRANCH NAME (display-only for commit-kind sides; identity is
    // anchorSha) — the merged record's summary sentence and the refpicker's
    // "deleted" chip render the branch name from compare.symbol (Tasks 16–17).
    dao.retargetSession(db, ctx.session.id, 'compare',
      { kind: 'commit', symbol: ctx.branch, anchorSha: ctx.tipSha })
    // Pin the BASE side too (§2 durability). Left as a live branch, the base symbol
    // resolves to the post-merge head, so getDiff collapses merge-base onto the tip
    // and the record renders an EMPTY diff for ff / merge / external merges (squash
    // survives only because its commit is a sibling of the tip). Freezing base at its
    // reviewed anchor makes getDiff(baseAnchor..tip) the exact reviewed diff for every
    // strategy — and keeps section/comment anchors resolving. retargetSessionBase is
    // the one audited writer allowed to touch a session base (retargetSession throws).
    dao.retargetSessionBase(db, ctx.session.id,
      { kind: 'commit', symbol: base.symbol, anchorSha: base.anchorSha })
  })
}

/** Spec §4: land the approved branch. Called INSIDE operations.run by the IPC
 *  handler. Re-gathers preflight authoritatively; any mismatch with what the sheet
 *  showed returns `preflight-changed` with nothing written. */
export async function executeMerge(db: DatabaseSync, sessionId: number, req: MergeExecuteRequest): Promise<MergeExecuteResult> {
  const ctx = await gatherContext(db, sessionId)
  const gates = evaluateMergeGates(ctx.inputs)
  if (
    !mergeOk(gates, req.overrides) ||
    ctx.baseHead !== req.expect.baseHead ||
    ctx.tipSha !== req.expect.tipSha ||
    !strategyAvailability(ctx.inputs)[req.strategy]
  ) {
    return { status: 'preflight-changed', preflight: toPreflight(ctx, gates) }
  }

  const message = req.message?.trim() || ctx.draftMessage
  const baseRef = `refs/heads/${ctx.baseSymbol}`
  let mergedSha: string
  try {
    if (ctx.baseWorkdir) {
      // base checked out (worktree verified clean by the gates): advance it through a
      // real merge so it doesn't go stale. mergeInWorktree aborts + throws on failure.
      mergedSha = await mergeInWorktree(ctx.baseWorkdir, ctx.branch, req.strategy, req.strategy === 'ff' ? undefined : message)
    } else if (req.strategy === 'ff') {
      await updateRefCas(ctx.repo, baseRef, ctx.tipSha, req.expect.baseHead)
      mergedSha = ctx.tipSha
    } else {
      // plumbing: the probe's treeOid IS the exact three-way result; on an
      // unavailable probe (git < 2.38) an ff-possible tip's own tree is identical.
      const treeOid = ctx.inputs.probe.treeOid
        ?? (ctx.inputs.ffPossible ? await headSha(ctx.repo, `${ctx.tipSha}^{tree}`) : null)
      if (!treeOid) {
        throw new Error('git merge-tree is unavailable (git < 2.38) and the base has moved — fast-forward, or check out the base branch and retry')
      }
      const parents = req.strategy === 'squash' ? [ctx.baseHead] : [ctx.baseHead, ctx.tipSha]
      const sha = await commitTree(ctx.repo, treeOid, parents, message)
      await updateRefCas(ctx.repo, baseRef, sha, req.expect.baseHead)
      mergedSha = sha
    }
  } catch (err) {
    // fails closed (Seq C): if the base moved between the re-check and the ref move,
    // the CAS/merge refused and nothing landed — report the fresh truth. Any other
    // failure propagates with git's stderr (still nothing recorded).
    const fresh = await gatherContext(db, sessionId)
    if (fresh.baseHead !== req.expect.baseHead) {
      return { status: 'preflight-changed', preflight: toPreflight(fresh, evaluateMergeGates(fresh.inputs)) }
    }
    throw err
  }

  const overrides: MergeOverride[] = req.overrides
    .map((id) => gates.find((g) => g.id === id && g.severity === 'amber'))
    .filter((g): g is MergeGate => Boolean(g))
    .map((g) => ({ gate: g.id, detail: g.detail }))
  const record: MergeRecord = {
    strategy: req.strategy,
    mergedSha,
    reviewedTipSha: ctx.tipSha,
    baseSymbol: ctx.baseSymbol,
    baseShaBefore: ctx.baseHead,
    mergedAt: new Date().toISOString(),
    ...(req.strategy === 'ff' ? {} : { message }),
    overrides,
    cleanup: emptyCleanup(),
    dependents: ctx.dependents.map((d) => d.branch)
  }
  await persistMergeRecord(db, ctx, record)
  await runCleanupAndRetargets(db, ctx, record, req.cleanup, mergedSha)
  try {
    // persist the final cleanup outcome — MUST NOT throw: the merge already landed
    // and the initial record (from persistMergeRecord) is durable, so a failure here
    // must not fail the whole handler and report a successful merge as an error to
    // the renderer. Record the failure in the returned record instead; the DB keeps
    // the initial (pre-cleanup) record, but the caller still sees the fuller truth.
    dao.markSessionMerged(db, sessionId, record)
  } catch (err) {
    record.cleanup.failures.push(`persist cleanup outcome: ${errorMessage(err)}`)
  }
  return { status: 'merged', record }
}

/** S12 "Mark merged": the merge already happened outside Limn (the approved tip is
 *  reachable from the base head) — write the same MergeRecord (external: true,
 *  mergedSha = base head), same keep-ref + compare-retarget durability, same cleanup
 *  path. No strategy/message input: nothing is landed here. */
export async function markMergedExternal(db: DatabaseSync, sessionId: number, cleanup: MergeCleanupRequest): Promise<MergeExecuteResult> {
  const ctx = await gatherContext(db, sessionId)
  if (!(await isAncestor(ctx.repo, ctx.tipSha, ctx.baseHead))) {
    throw new Error(`${ctx.branch} is not merged into ${ctx.baseSymbol}`)
  }
  const record: MergeRecord = {
    // ancestry can't recover the real strategy; ff when the base head IS the tip,
    // merge otherwise (external squash is undetectable and out of scope, spec §8).
    strategy: ctx.baseHead === ctx.tipSha ? 'ff' : 'merge',
    mergedSha: ctx.baseHead,
    reviewedTipSha: ctx.tipSha,
    baseSymbol: ctx.baseSymbol,
    baseShaBefore: ctx.baseHead,
    mergedAt: new Date().toISOString(),
    overrides: [],
    cleanup: emptyCleanup(),
    dependents: ctx.dependents.map((d) => d.branch),
    external: true
  }
  await persistMergeRecord(db, ctx, record)
  await runCleanupAndRetargets(db, ctx, record, cleanup, ctx.baseHead)
  try {
    // same "cannot reject a landed merge" guard as executeMerge: the settle already
    // durably recorded (persistMergeRecord); a failure here must only be reflected in
    // the returned record's cleanup.failures, never thrown as a handler error.
    dao.markSessionMerged(db, sessionId, record)
  } catch (err) {
    record.cleanup.failures.push(`persist cleanup outcome: ${errorMessage(err)}`)
  }
  return { status: 'merged', record }
}
