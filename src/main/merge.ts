import type { MergeGate, MergeGateId, MergeStrategy } from '../shared/types.js'
import type { MergeProbe } from './git.js'

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
