import type { DiffSkeleton, FileDiff } from '../../shared/types.js'

/** Max number of changed files in the since-diff for the scoped-update path. */
export const SCOPE_MAX_FILES = 8
/** Max Σ(add+del) lines in the since-diff (binary files contribute 0). */
export const SCOPE_MAX_LINES = 1000
/** Since-diff may touch at most this fraction of the full branch's files. */
export const SCOPE_MAX_FILE_RATIO = 0.5
/** After this many consecutive scoped iterations, force a full update to re-ground
 *  the narration and bound resumed-session context growth (spec §6/Q2). */
export const SCOPE_CHAIN_CAP = 5

/** Σ(add+del) across the since-diff. A binary file counts as 0 lines (git reports
 *  no line counts for binaries) but still as 1 file toward the file cap. */
function changedLines(since: FileDiff[]): number {
  return since.reduce((sum, f) => (f.binary ? sum : sum + f.add + f.del), 0)
}

/**
 * Pure predicate: is the drift since the last iteration "small enough" for the
 * scoped-update path? True iff ALL hold:
 *  - changed files ≤ SCOPE_MAX_FILES
 *  - changed lines (Σ add+del, binary = 0) ≤ SCOPE_MAX_LINES
 *  - changed files ≤ SCOPE_MAX_FILE_RATIO × full.files.length
 *    (drift touching most of the branch isn't "small")
 */
export function scopedEligible(since: FileDiff[], full: DiffSkeleton): boolean {
  return (
    since.length <= SCOPE_MAX_FILES &&
    changedLines(since) <= SCOPE_MAX_LINES &&
    since.length <= SCOPE_MAX_FILE_RATIO * full.files.length
  )
}
