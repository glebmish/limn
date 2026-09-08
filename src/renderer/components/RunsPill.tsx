import { useState } from 'react'
import { I } from '../kit'
import { activeChat, pendingApprovals, useStore } from '../store'
import { useFloating } from '../lib/useFloating'
import { pillModel } from '../lib/runsPill'

/** The Chat button with its pill (board 14 R2, v3): `N running · M queued`, amber
 *  `approval` when one waits on the reviewer, dashed `N proposed` when a run
 *  finished with results not yet looked at. Hover or focus lists Running / Queued
 *  (with a ✕ to leave the line) / Finished · unseen; a row opens the drawer on that
 *  thread. */
export function RunsPill({ chatOpen, onToggle }: { chatOpen: boolean; onToggle: () => void }) {
  const ops = useStore((s) => s.ops)
  const chats = useStore((s) => s.loaded?.state.chats ?? EMPTY_CHATS)
  const comments = useStore((s) => s.loaded?.state.comments ?? EMPTY)
  const seenThreadAt = useStore((s) => s.seenThreadAt)
  const shown = useStore((s) => (s.chatOpen ? activeChat(s.loaded, s.activeChatId, s.draftChat)?.id ?? null : null))
  const approvals = Object.values(ops).reduce((n, op) => n + pendingApprovals(op).length, 0)
  const openChat = useStore((s) => s.openChat)
  const cancelOp = useStore((s) => s.cancelOp)
  const model = pillModel({ ops, chats, comments, seenThreadAt, shownThreadId: shown, approvalsPending: approvals })
  const [hover, setHover] = useState(false)
  const listed = model.running.length + model.queued.length + model.unseen.length > 0
  const open = hover && listed
  const { anchorRef, floatingRef, style } = useFloating<HTMLSpanElement, HTMLDivElement>(open, { side: 'bottom', align: 'end', gap: 6 })
  const title = approvals > 0 ? 'Chat with the agent — waiting on your approval' : 'Chat with the agent'
  const row = (r: (typeof model.running)[number], extra?: React.ReactNode, cls = ''): React.ReactNode => (
    <div key={r.key} className={'ax-op' + cls} role="button" tabIndex={0}
      onClick={() => { if (r.threadId != null) openChat(r.threadId); setHover(false) }}
      onKeyDown={(e) => { if (e.key === 'Enter' && r.threadId != null) { openChat(r.threadId); setHover(false) } }}>
      <span className="nm"><b>{r.title}</b><i>{r.sub}</i></span>
      <span className="t">{r.time}</span>
      {extra}
    </div>
  )
  return (
    <span className="ax-act" ref={anchorRef} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} onFocus={() => setHover(true)} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setHover(false) }}>
      <button className={'btn btn-sm btn-ghost' + (chatOpen ? ' on' : '')} onClick={onToggle} title={title} aria-haspopup={listed ? 'true' : undefined}>
        <I.bubble style={{ width: 13, height: 13 }} />Chat
        {model.pill && (
          <span className={'pill pill-' + model.pill.kind} data-pill={model.pill.kind}>
            {model.pill.kind === 'run' && <span className="gen-spinner" />}
            {model.pill.kind === 'amber' && <I.warn />}
            {model.pill.text}
          </span>
        )}
      </button>
      {open && (
        <div className="ax-actpop" ref={floatingRef} style={style} role="menu" aria-label="Running and finished tasks">
          {model.running.length > 0 && <div className="g">Running · {model.running.length}</div>}
          {model.running.map((r) => row(r, <span className="st"><span className="gen-spinner" style={{ width: 11, height: 11 }} /></span>))}
          {model.queued.length > 0 && <div className="g">Queued · {model.queued.length}</div>}
          {model.queued.map((r) => row(r, r.opId ? (
            <button className="ax-op-x" title="Leave the line" aria-label={`Cancel ${r.title}`} onClick={(e) => { e.stopPropagation(); cancelOp(r.opId!) }}><I.x /></button>
          ) : undefined))}
          {model.unseen.length > 0 && <div className="g">Finished · unseen</div>}
          {model.unseen.map((r) => row(r, <span className="st ok"><I.check /></span>, ' done'))}
        </div>
      )}
    </span>
  )
}

const EMPTY: never[] = []
const EMPTY_CHATS: never[] = []
