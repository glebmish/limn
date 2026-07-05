import type { DependentReview, MergeGate, MergeGateId, MergeStrategy } from '../../shared/types'

/** Strategy preselection (spec resolution 6): the remembered per-repo choice while it
 *  is still available, else squash (agent-authored commit piles are the norm), else
 *  merge, else fast-forward. */
export function pickStrategy(
  remembered: MergeStrategy | undefined,
  strategies: Record<MergeStrategy, boolean>
): MergeStrategy {
  if (remembered && strategies[remembered]) return remembered
  if (strategies.squash) return 'squash'
  if (strategies.merge) return 'merge'
  return 'ff'
}

/** CTA label follows the strategy (design board 1 footer). */
export function ctaLabel(strategy: MergeStrategy, base: string): string {
  return strategy === 'ff' ? `Fast-forward ${base}`
    : strategy === 'squash' ? 'Squash & merge'
    : `Merge into ${base}`
}

/** Red gates always block; amber gates block until explicitly acked ("Merge anyway");
 *  info gates never block. Mirrors main's `mergeOk` so the CTA and the authoritative
 *  re-check agree. */
export function mergeBlocked(gates: MergeGate[], acked: ReadonlySet<MergeGateId>): boolean {
  return gates.some((g) => g.severity === 'red' || (g.severity === 'amber' && !acked.has(g.id)))
}

/** Dependents that keep the merged branch alive: not selected for retarget, or not
 *  rebasable. While any exist, branch deletion is refused (spec §4 step 5). */
export function deleteBranchBlockers(
  dependents: DependentReview[],
  retarget: ReadonlySet<number>
): DependentReview[] {
  return dependents.filter((d) => !d.rebasable || !retarget.has(d.sessionId))
}

/** The one-line reason beside a disabled CTA (design boards G1/C1; spec resolution 7). */
export function gateFooterNote(
  gates: MergeGate[],
  acked: ReadonlySet<MergeGateId>,
  busy: boolean
): string | null {
  if (busy) return 'Waiting for the running iteration.'
  if (gates.some((g) => g.id === 'conflicts')) return 'Gated until the probe is clean.'
  if (gates.some((g) => g.id === 'base-site-dirty' || g.id === 'branch-dirty')) return 'Gated until the worktree is clean.'
  if (gates.some((g) => g.id === 'stale-approval' && !acked.has('stale-approval'))) return 'Gated until approval covers HEAD.'
  if (gates.some((g) => g.id === 'base-moved' && !acked.has('base-moved'))) return 'Gated until the branch is rebased — or merge anyway.'
  return null
}
