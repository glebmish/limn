import type { DatabaseSync } from 'node:sqlite'
import type {
  DependentReview, MergeGate, MergeGateId, MergePreflight, MergeStrategy, ReviewState, SessionMeta
} from '../shared/types.js'
import {
  aheadCount, branchCheckedOutAt, dirtyCount, driftSummary, EMPTY_TREE, headSha,
  isAncestor, isDirty, log, mergeBase, mergeTreeProbe, type MergeProbe
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
