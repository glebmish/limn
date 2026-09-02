/** Which committed state the "since" slice of a review is measured against.
 *
 *  The server's baseline is `approvedSha ?? reviewedAtSha` — so a review that was
 *  never approved still gets a since-diff, measured from the sha the review was
 *  GENERATED at. Calling that "Since approved" in the UI is a lie, and it made the
 *  amber drift rails unreadable ("approved? I never approved this"). Both sides
 *  derive the baseline here so the label always matches the sha it came from. */
export type SinceBasis = 'approved' | 'generated'

export interface SinceBaselineState {
  approvedSha?: string
  approvedShas?: string[]
  reviewedAtSha?: string
}

/** Every committed state explicitly approved in this session, normalized: the
 *  recorded list, else the single legacy sha, else nothing. */
export function approvedShaList(state: SinceBaselineState): string[] {
  return state.approvedShas ?? (state.approvedSha ? [state.approvedSha] : [])
}

/** The baseline sha for the since-diff, and what it actually is. Null when the
 *  review has neither an approval nor a generated baseline (nothing to diff since). */
export function sinceBasis(state: SinceBaselineState, headSha: string): { sha: string; basis: SinceBasis } | null {
  const approvedShas = approvedShaList(state)
  // an approved head means the reader is caught up: keep it as the baseline so the
  // since-slice comes out empty rather than replaying an older approval's drift
  if (approvedShas.includes(headSha)) return { sha: headSha, basis: 'approved' }
  if (state.approvedSha) return { sha: state.approvedSha, basis: 'approved' }
  if (state.reviewedAtSha) return { sha: state.reviewedAtSha, basis: 'generated' }
  return null
}

/** The baseline's name wherever it is offered or explained. */
export function sinceModeLabel(basis: SinceBasis): string {
  return basis === 'approved' ? 'Since approved' : 'Since the review ran'
}

/** The label a diff baseline goes by anywhere it is offered — the page header's
 *  bulk switch and each file's own picker read from here, so the two never disagree. */
export function baselineLabel(mode: 'branch' | 'approved' | 'viewed', basis: SinceBasis): string {
  return mode === 'approved' ? sinceModeLabel(basis) : mode === 'viewed' ? 'Since viewed' : 'Full diff'
}
