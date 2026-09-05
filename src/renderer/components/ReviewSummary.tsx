import { useState } from 'react'
import type { AgentRef, Comment, MergeRecord, ReviewAnnotations } from '../../shared/types'
import { CmtPlus, EngineGlyph, I, shortSha, strategyLabel } from '../kit'
import { useStore } from '../store'
import { Composer, InlineThread } from './Threads'
import { Commentable, SelectionThreads } from './Commentable'

/** The review-title comment threads and — when annotated — the `rr-summary` band
 *  (the generated summary; drift is the header pill's and the rail's job, and an
 *  update replaces the summary wholesale, so there is no "since" variant to show),
 *  its comment threads, and the selection threads. Rendered directly under GenPanel;
 *  markup is verbatim. `titleCommenting` is shared with the page-head H1, so it's a
 *  prop; `summaryCommenting` lives entirely here, so it's local state. */
export function ReviewSummary({
  annotations,
  titleComments,
  titleCommenting,
  setTitleCommenting,
  summaryComments,
  guidedBy,
  merged,
  mergedBranch
}: {
  annotations: ReviewAnnotations | undefined
  titleComments: Comment[]
  titleCommenting: boolean
  setTitleCommenting: (v: boolean) => void
  summaryComments: Comment[]
  guidedBy: AgentRef
  /** terminal merge record (spec §7) — renders the read-only banner above everything */
  merged?: MergeRecord
  mergedBranch?: string
}) {
  const [summaryCommenting, setSummaryCommenting] = useState(false)
  return (
    <>
      {merged && <MergedBand merged={merged} branch={mergedBranch} />}
      {(titleComments.length > 0 || titleCommenting) && (
        <div className="title-threads">
          {titleComments.map((c) => <InlineThread key={c.id} c={c} locLabel="on the review title" />)}
          {titleCommenting && (
            <Composer
              placeholder="Comment on the review title — the agent gets it with your next batch…"
              onCancel={() => setTitleCommenting(false)}
              onSubmit={(text) => { void useStore.getState().addComment({ kind: 'title' }, text); setTitleCommenting(false) }}
            />
          )}
        </div>
      )}

      {annotations && (
        <>
          <div className="rr-summary rr-summary-cmt" data-limn-summary style={{ background: 'var(--accent-soft)', borderColor: 'var(--accent-line)' }}>
            {!merged && <CmtPlus extra="summary-plus" onClick={() => setSummaryCommenting(true)} />}
            <span className="rr-ic" style={{ background: 'var(--accent)' }}><EngineGlyph engine={guidedBy.engine} style={{ width: 14, height: 14 }} /></span>
            <Commentable scope={{ region: 'summary' }} className="rr-tx">{annotations.summary}</Commentable>
            <span className="grow"></span>
          </div>
          {(summaryComments.length > 0 || summaryCommenting) && (
            <div className="rr-summary-threads">
              {summaryComments.map((c) => <InlineThread key={c.id} c={c} locLabel="on the summary" />)}
              {summaryCommenting && (
                <Composer
                  placeholder="Comment on the overall review summary — the agent gets it with your next batch…"
                  onCancel={() => setSummaryCommenting(false)}
                  onSubmit={(text) => { void useStore.getState().addComment({ kind: 'summary' }, text); setSummaryCommenting(false) }}
                />
              )}
            </div>
          )}
          <div className="rr-summary-threads"><SelectionThreads scope={{ region: 'summary' }} /></div>
        </>
      )}
    </>
  )
}

/** Read-only banner for a landed review (spec §7): the merge fact from the record —
 *  where/when/how it landed, what cleanup ran, any override note (S13), then the
 *  "read-only record" close. All fields come from MergeRecord; nothing is inferred. */
function MergedBand({ merged, branch }: { merged: MergeRecord; branch?: string }) {
  const when = new Date(merged.mergedAt)
  const date = Number.isNaN(when.getTime())
    ? '' : ` on ${when.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`
  const br = branch ?? 'The branch'
  const cleanupBits: string[] = []
  if (merged.cleanup.branchDeleted) cleanupBits.push('was deleted')
  if (merged.cleanup.worktreeRemoved) cleanupBits.push('its worktree removed')
  const cleanup = cleanupBits.length ? ` ${br} ${cleanupBits.join(' and ')}.` : ''
  const retargeted = merged.cleanup.retargeted.length
    ? ` ${merged.cleanup.retargeted.length} dependent review${merged.cleanup.retargeted.length === 1 ? '' : 's'} rebased onto ${merged.baseSymbol}.` : ''
  const overrideNote = merged.overrides.length
    ? ` Landed over ${merged.overrides.length} acknowledged gate${merged.overrides.length === 1 ? '' : 's'} (${merged.overrides.map((o) => o.detail).join('; ')}).` : ''
  return (
    <div className="rr-merged" data-limn-merged role="status">
      <span className="rrm-ic"><I.merge style={{ width: 15, height: 15 }} /></span>
      <div className="rrm-tx">
        <strong>Merged into {merged.baseSymbol}</strong> at <span className="mono">{shortSha(merged.mergedSha)}</span>{' '}
        ({strategyLabel(merged.strategy)}){date}.{merged.external ? ' Recorded from a merge made outside Limn.' : ''}
        {cleanup}{retargeted}{overrideNote}
        {merged.cleanup.failures.length > 0 && (
          <span className="rrm-warn"> Some cleanup did not complete: {merged.cleanup.failures.join('; ')}.</span>
        )}
        {' '}This review is now a read-only record.
      </div>
    </div>
  )
}
