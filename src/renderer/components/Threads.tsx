import { useState } from 'react'
import type { AgentRef, Comment } from '../../shared/types'
import { I, Ava, EngineGlyph } from '../kit'
import { agentLabel } from '../../shared/agents'
import { useStore } from '../store'
import { currentReviewChat, deleteComment, editComment, sendComments } from '../lib/comments'

const VERDICT_ICON = { addressed: '✓', reworked: '↻', skipped: '✗' } as const

/** Clickable agent-identity chip — opens that agent's chat thread. */
function AgentId({ agentRef, threadId }: { agentRef?: AgentRef; threadId?: number }) {
  const openChat = useStore((s) => s.openChat)
  if (!agentRef) return <><Ava ai>AI</Ava><b>Agent</b></>
  return (
    <button className="limn-agentid" title="Open this agent's chat" onClick={() => openChat(threadId)}>
      <Ava ai>AI</Ava><b>{agentLabel(agentRef)}</b><I.chevR style={{ width: 10, height: 10 }} />
    </button>
  )
}

export function InlineThread({ c, locLabel }: { c: Comment; locLabel: string }) {
  const [editing, setEditing] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  const [draft, setDraft] = useState(c.text)
  const isAgent = c.author === 'agent'
  // engine a queued comment will be sent to = the review agent
  const reviewEngine = useStore((s) => s.loaded?.state.agent?.engine)
  const reviewChat = useStore((s) => currentReviewChat(s.loaded?.state.chats ?? []))
  const reviewAgent = useStore((s) => s.loaded?.state.agent)
  const openChat = useStore((s) => s.openChat)

  // delete is destructive with no undo, so confirm inline before removing
  const deleteControl = confirmDel ? (
    <>
      <span className="dim">Delete this comment?</span>
      <button className="del-confirm" onClick={() => void deleteComment(c.id)}>Confirm</button>
      <button onClick={() => setConfirmDel(false)}>Cancel</button>
    </>
  ) : (
    <button onClick={() => setConfirmDel(true)}>Delete</button>
  )

  return (
    <div className="dthread">
      <div className={'box' + (isAgent ? ' agent' : '')}>
        <div className="bh">
          {isAgent ? <AgentId agentRef={c.agentRef} threadId={c.threadId} /> : <><Ava>me</Ava><b>You</b></>}
          <span className="dim">{locLabel}</span>
          {!isAgent && c.status === 'queued' && (
            <>
              <span className="agentq"><EngineGlyph engine={reviewEngine} style={{ width: 11, height: 11 }} />queued for agent</span>
              <button className="send-now" onClick={() => sendComments([c.id])}>
                <I.send style={{ width: 11, height: 11 }} />Send now
              </button>
            </>
          )}
          {!isAgent && (c.status === 'sent' || c.status === 'resolved') && (() => {
            const chipAgent = c.agentRef ?? reviewAgent
            return (
              <button className="limn-agentid" title="Open the agent's chat" onClick={() => openChat(c.threadId ?? reviewChat?.id)}>
                <EngineGlyph engine={chipAgent?.engine ?? reviewEngine} style={{ width: 11, height: 11 }} />
                {chipAgent ? agentLabel(chipAgent) : 'agent'}
                {c.status === 'sent' && <span className="dim" style={{ fontWeight: 400 }}> · with agent…</span>}
                <I.chevR style={{ width: 10, height: 10 }} />
              </button>
            )
          })()}
          {!isAgent && c.status === 'outdated' && <span className="agentq" style={{ color: 'var(--muted)' }}>outdated</span>}
          {c.status === 'resolved' && c.resolution && (
            <span
              className="agentq"
              style={{ color: c.resolution.verdict === 'skipped' ? 'var(--red)' : c.resolution.verdict === 'reworked' ? 'var(--amber)' : undefined }}
              title={c.resolution.note}
            >
              {VERDICT_ICON[c.resolution.verdict]} {c.resolution.verdict}
              {c.resolution.commit && <span className="mono" style={{ marginLeft: 4 }}>{c.resolution.commit}</span>}
            </span>
          )}
        </div>
        {editing ? (
          <div className="t-body" style={{ padding: '10px 12px' }}>
            <textarea
              className="rg-steer"
              style={{ width: '100%', margin: 0 }}
              rows={2}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              autoFocus
            />
            <div style={{ display: 'flex', gap: 7, marginTop: 8 }}>
              <button className="btn btn-sm btn-primary" onClick={() => { void editComment(c, draft); setEditing(false) }}>Save</button>
              <button className="btn btn-sm btn-ghost" onClick={() => setEditing(false)}>Cancel</button>
            </div>
          </div>
        ) : (
          <div className="bb">{c.text}</div>
        )}
        {c.resolution?.note && c.status === 'resolved' && (
          <div className="bb" style={{ paddingTop: 0, color: 'var(--muted)', fontSize: 12 }}>
            <EngineGlyph engine={c.resolution.agentRef?.engine} style={{ width: 10, height: 10, color: 'var(--accent)', marginRight: 5 }} />
            {c.resolution.note}
          </div>
        )}
        {c.replies.map((r, i) => (
          <div key={i} className="dreply">
            <div className="bh">
              {r.author === 'agent' ? <AgentId agentRef={r.agentRef} threadId={r.threadId} /> : <><Ava>me</Ava><b>You</b></>}
              <span className="dim">replied</span>
            </div>
            <div className="bb">{r.text}</div>
          </div>
        ))}
        {!editing && !isAgent && c.status !== 'sent' && (
          <div className="bf">
            {c.status !== 'resolved' && !confirmDel && <button onClick={() => setEditing(true)}>Edit</button>}
            {deleteControl}
          </div>
        )}
        {!editing && isAgent && (
          <div className="bf">{deleteControl}</div>
        )}
      </div>
    </div>
  )
}

/** Inline composer. Defaults describe a *queued* comment (folded into the next
 *  batch). `sendNow` flips the labels for the decision flow, where submitting sends
 *  to the agent immediately and resolves the question. */
export function Composer({ placeholder, onSubmit, onCancel, sendNow = false }: {
  placeholder: string
  onSubmit: (text: string) => void
  onCancel: () => void
  sendNow?: boolean
}) {
  const [text, setText] = useState('')
  // send-now composers name the agent they go straight to (no queue)
  const agent = useStore((s) => s.loaded?.state.agent)
  const submitLabel = sendNow ? 'Send now' : 'Add comment'
  // send-now needs no hint — the "→ agent" destination chip already says it all
  const hint = sendNow ? '' : 'queues for the agent — nothing is sent yet'
  return (
    <div className="dthread">
      <div className="box">
        <div className="bh">
          <Ava>me</Ava><b>You</b>
          {sendNow && agent && (
            <>
              <span className="dim" style={{ margin: '0 1px' }}>→</span>
              <span className="limn-dest" title="answering goes straight to this agent"><EngineGlyph engine={agent.engine} style={{ width: 11, height: 11 }} />{agentLabel(agent)}</span>
            </>
          )}
          <span className="dim" style={sendNow ? { marginLeft: 'auto' } : undefined}>{sendNow ? 'your decision' : 'new comment'}</span>
        </div>
        <div style={{ padding: '10px 12px' }}>
          <textarea
            className="rg-steer"
            style={{ width: '100%', margin: 0 }}
            rows={2}
            placeholder={placeholder}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim()) onSubmit(text.trim())
              if (e.key === 'Escape') onCancel()
            }}
            autoFocus
          />
          <div style={{ display: 'flex', gap: 7, marginTop: 8, alignItems: 'center' }}>
            <button className="btn btn-sm btn-primary" disabled={!text.trim()} onClick={() => onSubmit(text.trim())}>
              {sendNow ? <I.send style={{ width: 12, height: 12 }} /> : <I.bubble style={{ width: 12, height: 12 }} />}{submitLabel}
            </button>
            <button className="btn btn-sm btn-ghost" onClick={onCancel}>Cancel</button>
            {hint && <span className="dim" style={{ fontSize: 10.5 }}>{hint}</span>}
          </div>
        </div>
      </div>
    </div>
  )
}
