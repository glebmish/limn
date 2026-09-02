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

/** A baseline the reader can switch the diff to, beyond the full branch diff. The
 *  two commit-level ones are tracked independently — `reviewedAtSha` moves on every
 *  generate, `approvedSha` on every approval — so after an approve-then-regenerate
 *  the newer of the two is NOT always the approval. Listing them separately is what
 *  keeps "since approved" from silently showing an older slice than the review you
 *  are reading. (The per-file "since viewed" baseline is not here: it is per file,
 *  from that file's own view mark.) */
export interface CommitBaseline { mode: 'review' | 'approved'; sha: string }

/** The distinct commit baselines this review offers, oldest concern first. Collapses
 *  the two into one when they are the same commit — a review generated at the sha you
 *  approved has one window, not two identical ones.
 *
 *  A baseline equal to the head is dropped by default: nothing has changed since it in
 *  COMMITTED space. Pass `includeHead` for the working-tree pass, where it is exactly
 *  the interesting case — approve a commit, then edit the tree, and "since approved" is
 *  those uncommitted lines (the per-surface approval rule in docs/using-limn.md). */
export function commitBaselines(
  state: SinceBaselineState, headSha: string, opts: { includeHead?: boolean } = {}
): CommitBaseline[] {
  const approved = approvedShaList(state).includes(headSha) ? headSha : state.approvedSha
  const keep = (sha: string): boolean => opts.includeHead === true || sha !== headSha
  const out: CommitBaseline[] = []
  if (state.reviewedAtSha && keep(state.reviewedAtSha) && state.reviewedAtSha !== approved) {
    out.push({ mode: 'review', sha: state.reviewedAtSha })
  }
  if (approved && keep(approved)) out.push({ mode: 'approved', sha: approved })
  return out
}

/** The baseline's name wherever it is offered or explained. */
export function sinceModeLabel(basis: SinceBasis): string {
  return basis === 'approved' ? 'Since approved' : 'Since the review ran'
}

/** The label a diff baseline goes by anywhere it is offered — the page header's bulk
 *  switch and each file's own picker read from here, so the two never disagree. Each
 *  baseline now names its own checkpoint: no label has to stand in for two of them. */
export function baselineLabel(mode: 'branch' | 'review' | 'approved' | 'viewed'): string {
  return mode === 'review' ? sinceModeLabel('generated')
    : mode === 'approved' ? sinceModeLabel('approved')
    : mode === 'viewed' ? 'Since viewed'
    : 'Full diff'
}
