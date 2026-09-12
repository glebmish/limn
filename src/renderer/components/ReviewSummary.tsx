import { useState } from 'react'
import type { AgentRef, Comment, Iteration, ReviewAnnotations } from '../../shared/types'
import { CmtPlus, EngineGlyph, shortSha } from '../kit'
import { useStore } from '../store'
import { Composer, InlineThread } from './Threads'
import { Commentable, SelectionThreads } from './Commentable'

/** The review-title comment threads and — when annotated — the `rr-summary` band
 *  (the "since you approved" iteration summary or the original generated summary),
 *  its comment threads, and the selection threads. Rendered directly under GenPanel;
 *  markup is verbatim. `titleCommenting` is shared with the page-head H1, so it's a
 *  prop; `summaryCommenting` lives entirely here, so it's local state. */
export function ReviewSummary({
  annotations,
  titleComments,
  titleCommenting,
  setTitleCommenting,
  summaryComments,
  sinceTagged,
  lastIteration,
  baseline,
  guidedBy
}: {
  annotations: ReviewAnnotations | undefined
  titleComments: Comment[]
  titleCommenting: boolean
  setTitleCommenting: (v: boolean) => void
  summaryComments: Comment[]
  sinceTagged: boolean
  lastIteration: Iteration | undefined
  baseline: string | undefined
  guidedBy: AgentRef
}) {
  const [summaryCommenting, setSummaryCommenting] = useState(false)
  return (
    <>
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
          {sinceTagged && lastIteration?.summary ? (
            <div className="rr-summary rr-summary-cmt" data-limn-summary>
              <CmtPlus extra="summary-plus" onClick={() => setSummaryCommenting(true)} />
              <span className="rr-ic"><EngineGlyph engine={lastIteration?.engine} style={{ width: 14, height: 14 }} /></span>
              <Commentable scope={{ region: 'summary' }} className="rr-tx">
                <span className="rr-lead">Since you approved{baseline ? <> at <span className="mono">{shortSha(baseline)}</span></> : ''}: </span>
                {lastIteration.summary}
              </Commentable>
            </div>
          ) : (
            <div className="rr-summary rr-summary-cmt" data-limn-summary style={{ background: 'var(--accent-soft)', borderColor: 'var(--accent-line)' }}>
              <CmtPlus extra="summary-plus" onClick={() => setSummaryCommenting(true)} />
              <span className="rr-ic" style={{ background: 'var(--accent)' }}><EngineGlyph engine={guidedBy.engine} style={{ width: 14, height: 14 }} /></span>
              <Commentable scope={{ region: 'summary' }} className="rr-tx">{annotations.summary}</Commentable>
              <span className="grow"></span>
            </div>
          )}
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
