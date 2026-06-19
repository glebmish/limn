import { I } from '../kit'
import type { ApprovalDecision, ApprovalRequest } from '../../shared/types'

/** Blocking approval prompt shown live during a turn (above the composer). The
 *  agent waits until the reviewer answers; the decision routes back to the engine. */
export function ApprovalCard({ request, index, total, onDecide, onStop }: {
  request: ApprovalRequest
  index: number
  total: number
  onDecide: (d: ApprovalDecision) => void
  onStop: () => void
}) {
  const files = request.detail?.files
  return (
    <div className="approval-card">
      <div className="ac-head">
        <I.warn className="ac-ico" />
        <span className="ac-kind">{request.kind.replace('_', ' ')}</span>
        {request.risk && <span className={'ac-risk ' + request.risk}>{request.risk} risk</span>}
        {total > 1 && <span className="ac-count">{index + 1}/{total}</span>}
      </div>
      <div className="ac-summary">{request.summary}</div>
      {request.detail?.command && (
        <div className="ac-detail">
          <code className="ac-cmd">{request.detail.command}</code>
          {request.detail.cwd && <div className="ac-cwd">in {request.detail.cwd}</div>}
        </div>
      )}
      {files && files.length > 0 && (
        <div className="ac-detail ac-files">{files.join('\n')}</div>
      )}
      <div className="ac-actions">
        <button className="btn btn-primary btn-sm" onClick={() => onDecide('allow')}>
          <I.check style={{ width: 12, height: 12 }} />Approve
        </button>
        <button className="btn btn-sm ac-deny" onClick={() => onDecide('deny')}>
          <I.x style={{ width: 11, height: 11 }} />Deny
        </button>
        <button className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }} onClick={onStop}>Stop turn</button>
      </div>
    </div>
  )
}
