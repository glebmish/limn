import { useEffect, useRef, useState } from 'react'
import { I } from '../kit'
import { clickable } from '../lib/clickable'
import type { ApprovalDecision, ApprovalRequest } from '../../shared/types'

/** Blocking approval prompt shown live during a turn (above the composer). The
 *  agent waits until the reviewer answers; the decision routes back to the engine.
 *  #15: the reviewer needs the path (always shown, when the payload carries one)
 *  plus a collapsed-by-default diff preview — approve/deny is uninformed consent
 *  otherwise. Defensive throughout: a request with no `detail` at all (e.g. a
 *  degraded turn with no opId) still renders the summary/kind it always has.
 *
 *  The caller keys the card by request id, so every new request mounts a fresh
 *  card. Approve/Deny stay disabled for `armDelayMs` after mount: answering one
 *  request drops it from the queue synchronously and the next one renders in the
 *  same spot, so without the beat a double-click would answer a request the
 *  reviewer never saw. A card also answers at most once. */
export const APPROVAL_ARM_MS = 450

export function ApprovalCard({ request, index, total, onDecide, onStop, initialOpen = false, armDelayMs = APPROVAL_ARM_MS }: {
  request: ApprovalRequest
  index: number
  total: number
  /** Receives the id of the request this card rendered — never re-read the queue at click time. */
  onDecide: (d: ApprovalDecision, requestId: string) => void
  onStop: () => void
  /** Test seam only — lets renderToStaticMarkup-based tests pin the expanded
   *  diff body without simulating a click (no jsdom/@testing-library in this
   *  repo). Not used by any production caller; defaults to collapsed. */
  initialOpen?: boolean
  /** How long Approve/Deny stay disabled after the card mounts (0 = armed at once). */
  armDelayMs?: number
}) {
  const [diffOpen, setDiffOpen] = useState(initialOpen)
  const [armed, setArmed] = useState(armDelayMs <= 0)
  const decided = useRef(false)
  useEffect(() => {
    if (armDelayMs <= 0) return
    const t = setTimeout(() => setArmed(true), armDelayMs)
    return () => clearTimeout(t)
  }, [armDelayMs])
  const decide = (d: ApprovalDecision): void => {
    if (!armed || decided.current) return
    decided.current = true
    onDecide(d, request.id)
  }
  const files = request.detail?.files
  const diffs = request.detail?.diffs ?? []
  return (
    <div className="approval-card" role="alertdialog" aria-label="Approval required">
      <div className="ac-head">
        <I.warn className="ac-ico" />
        <span className="ac-kind">{request.kind.replace(/_/g, ' ')}</span>
        {total > 1 && <span className="ac-count">{index + 1}/{total}</span>}
      </div>
      <div className="ac-summary">{request.summary}</div>
      {request.detail?.reason && (
        <div className="ac-reason">Reason: {request.detail.reason}</div>
      )}
      {request.detail?.command && (
        <div className="ac-detail">
          <code className="ac-cmd">{request.detail.command}</code>
          {request.detail.cwd && <div className="ac-cwd">in {request.detail.cwd}</div>}
        </div>
      )}
      {files && files.length > 0 && (
        <div className="ac-detail ac-files">{files.join('\n')}</div>
      )}
      {diffs.length > 0 && (
        <div className="ac-diff">
          <div className="ac-diff-toggle" {...clickable(() => setDiffOpen((o) => !o), { expanded: diffOpen })}>
            {diffOpen ? <I.chevD className="ac-diff-cv" /> : <I.chevR className="ac-diff-cv" />}
            {diffOpen ? 'Hide diff' : 'Show diff'}
          </div>
          {diffOpen && (
            <div className="ac-diff-body">
              {diffs.map((d, i) => (
                <div className="ac-diff-file" key={d.path + i}>
                  {diffs.length > 1 && <div className="ac-diff-path">{d.path}</div>}
                  {d.oldText !== undefined && (
                    <div className="ac-diff-block ac-diff-old">
                      <div className="ac-diff-label">− before</div>
                      <pre>{d.oldText}</pre>
                    </div>
                  )}
                  <div className="ac-diff-block ac-diff-new">
                    <div className="ac-diff-label">+ after</div>
                    <pre>{d.newText}</pre>
                  </div>
                </div>
              ))}
              {!!request.detail?.moreFiles && (
                <div className="ac-diff-more">+{request.detail.moreFiles} more files</div>
              )}
            </div>
          )}
        </div>
      )}
      <div className="ac-actions">
        <button className="btn btn-primary btn-sm" disabled={!armed} onClick={() => decide('allow')}>
          <I.check style={{ width: 12, height: 12 }} />Approve
        </button>
        <button className="btn btn-sm ac-deny" disabled={!armed} onClick={() => decide('deny')}>
          <I.x style={{ width: 11, height: 11 }} />Deny
        </button>
        <button className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }} onClick={onStop}>Stop turn</button>
      </div>
    </div>
  )
}
