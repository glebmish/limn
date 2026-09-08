import { useEffect, useState } from 'react'
import { I } from '../kit'
import { useStore } from '../store'
import { commentJumpTarget, focusAnchor } from '../lib/focus'
import { clampStep, focusProposalBox, stripView } from '../lib/proposals'
import { KindGlyph } from './ActionMarks'

/** The strip above the diff (board 14 T1, v3): the newest run with proposals to
 *  triage — `/Simplify · run 2 · 4 proposed · ‹ 1 of 4 › · Accept all · Dismiss all ·
 *  1 dismissed · Restore · thread ↗`. The stepper routes through the jump pipeline
 *  and lands keyboard focus on the box, so a / k / d / r work from there. */
export function ProposalStrip() {
  const comments = useStore((s) => s.loaded?.state.comments ?? EMPTY)
  const chats = useStore((s) => s.loaded?.state.chats ?? EMPTY_CHATS)
  const triage = useStore((s) => s.triageFindings)
  const openChat = useStore((s) => s.openChat)
  const view = stripView(comments, chats)
  const [idx, setIdx] = useState(-1)
  const count = view?.open.length ?? 0
  useEffect(() => { setIdx((i) => clampStep(i, count)) }, [count, view?.runId])
  if (!view) return null
  const go = (i: number): void => {
    const next = clampStep(i, count)
    if (next < 0) return
    setIdx(next)
    const c = view.open[next]
    const target = commentJumpTarget(c)
    if (target) focusAnchor(target)
    focusProposalBox(c.id)
  }
  const src = `${view.name}${view.n != null ? ` · run ${view.n}` : ''}`
  const openIds = view.open.map((c) => c.id)
  if (count === 0) {
    return (
      <div className="ax-triage empty" role="status">
        <span className="ax-run-src">{view.kind && <KindGlyph kind={view.kind} small />}{src}</span>
        <span>no proposals left{view.dismissed.length ? ` · ${view.dismissed.length} dismissed` : ''}</span>
        <span className="grow" />
        {view.dismissed.length > 0 && <a onClick={() => void triage(view.dismissed.map((c) => c.id), 'restore')}>Restore</a>}
        {view.threadId != null && <a onClick={() => openChat(view.threadId!)}>thread ↗</a>}
      </div>
    )
  }
  return (
    <div className="ax-triage" role="toolbar" aria-label="Proposed findings">
      <span className="ax-run-src">{view.kind && <KindGlyph kind={view.kind} small />}{src}</span>
      <b>{count} proposed</b>
      <span className="ax-step">
        <button className="ax-step-btn" title="Previous proposal" aria-label="Previous proposal" onClick={() => go(idx <= 0 ? count - 1 : idx - 1)}>‹</button>
        <span className="ax-step-n">{idx < 0 ? '–' : idx + 1} of {count}</span>
        <button className="ax-step-btn" title="Next proposal" aria-label="Next proposal" onClick={() => go(idx < 0 ? 0 : (idx + 1) % count)}>›</button>
      </span>
      <span className="grow" />
      <button className="btn btn-sm btn-primary" onClick={() => void triage(openIds, 'accept')}><I.check style={{ width: 11, height: 11 }} />Accept all</button>
      <button className="btn btn-sm" onClick={() => void triage(openIds, 'dismiss')}>Dismiss all</button>
      {view.dismissed.length > 0 && <a onClick={() => void triage(view.dismissed.map((c) => c.id), 'restore')} title="Show the dismissed ones again">{view.dismissed.length} dismissed · Restore</a>}
      {view.threadId != null && <a onClick={() => openChat(view.threadId!)}>thread ↗</a>}
    </div>
  )
}

const EMPTY: never[] = []
const EMPTY_CHATS: never[] = []
