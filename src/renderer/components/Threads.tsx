import { useState, type ReactElement } from 'react'
import type { AgentRef, Comment } from '../../shared/types'
import { I, Ava, EngineGlyph } from '../kit'
import { agentLabel } from '../../shared/agents'
import { activeChat, useStore } from '../store'
import { currentReviewChat, sendComments } from '../lib/comments'

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

/** Resolved-comment re-queue control (spec Decision 19): a resolved comment —
 *  reviewer-authored or an agent hotspot alike — keeps a way back into the batch.
 *  Purely a status flip (`requeueComment`, persisted via upsertComment); it never
 *  sends/dispatches anything itself — the reviewer still clicks the ordinary
 *  queued-comment "Send now" separately. This is what "unjams" a hotspot: agree
 *  with it, one click queues it, same as any comment. */
function RequeueButton({ c }: { c: Comment }) {
  return (
    <button className="requeue" onClick={() => void useStore.getState().requeueComment(c)} title="Queue this comment for the agent">
      <I.send style={{ width: 11, height: 11 }} />Re-queue
    </button>
  )
}

/** A thread's verdict chip text: the icon and the word, for a live resolution or one
 *  folded into the replies. */
function verdictLabel(verdict: 'addressed' | 'reworked' | 'skipped'): string {
  return `${VERDICT_ICON[verdict]} ${verdict}`
}

export function InlineThread({ c, locLabel }: { c: Comment; locLabel: string }) {
  const [editing, setEditing] = useState(false)
  const [replying, setReplying] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  const [draft, setDraft] = useState(c.text)
  const isAgent = c.author === 'agent'
  // engine a queued comment will be sent to = the *active* chat's agent (the
  // destination the drawer's batch CTA also targets), falling back to the review agent.
  const reviewEngine = useStore((s) => s.loaded?.state.agent?.engine)
  const activeAgent = useStore((s) => activeChat(s.loaded, s.activeChatId, s.draftChat)?.agent)
  // the fallback thread for a comment that predates per-comment thread ids: the same
  // pick every review-scoped send makes — the thread that authored the latest
  // iteration, else the newest review thread (an aborted regenerate leaves an empty
  // newest one, which is not where anything was sent)
  const reviewChat = useStore((s) => currentReviewChat(s.loaded?.state.chats ?? [], s.loaded?.state.latestIteration?.sessionId))
  const reviewAgent = useStore((s) => s.loaded?.state.agent)
  const openChat = useStore((s) => s.openChat)
  // terminal merged record (spec §7): comments are read-only — no send/edit/delete
  const merged = useStore((s) => Boolean(s.loaded?.state.merged))

  // delete is destructive with no undo, so confirm inline before removing
  const deleteControl = confirmDel ? (
    <>
      <span className="dim">Delete this comment?</span>
      <button className="del-confirm" onClick={() => void useStore.getState().deleteComment(c.id)}>Confirm</button>
      <button onClick={() => setConfirmDel(false)}>Cancel</button>
    </>
  ) : (
    <button onClick={() => setConfirmDel(true)}>Delete</button>
  )

  // The thread's status chips (queued · Send now / with agent… / outdated / the
  // verdict) sit on the LATEST turn, not always on the card header: a reply lands at
  // the bottom of the thread, and a "queued for agent" chip at the top of the card
  // said nothing about it. `author` is the turn's author — but queued/outdated
  // describe the COMMENT's status, so they render whoever spoke last: an agent
  // hotspot the reviewer re-queued (spec Decision 19) is queued for the agent exactly
  // like a reviewer comment, and its card used to say nothing at all. The agent-
  // IDENTITY chip stays reviewer-only: an agent turn already renders that agent
  // beside it (the card header's AgentId, the resolution entry's), so an ungated one
  // would just be a duplicate chip.
  const statusChips = (author: 'user' | 'agent'): ReactElement => (
    <>
      {c.status === 'queued' && (
        <>
          <span className="agentq"><EngineGlyph engine={activeAgent?.engine ?? reviewEngine} style={{ width: 11, height: 11 }} />{merged ? 'never sent' : 'queued for agent'}</span>
          {!merged && (
            <button className="send-now" onClick={() => sendComments([c.id])}>
              <I.send style={{ width: 11, height: 11 }} />Send now
            </button>
          )}
        </>
      )}
      {author === 'user' && (c.status === 'sent' || c.status === 'resolved') && (() => {
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
      {c.status === 'outdated' && <span className="agentq" style={{ color: 'var(--muted)' }}>outdated</span>}
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
    </>
  )
  const showResolution = c.status === 'resolved' && Boolean(c.resolution?.note)
  // where the chips go: the resolution entry (rendered last), else the last reply,
  // else the card header
  const lastTurn: 'resolution' | 'reply' | 'head' = showResolution ? 'resolution' : c.replies.length ? 'reply' : 'head'

  return (
    <div className="dthread">
      <div className={'box' + (isAgent ? ' agent' : '')}>
        <div className="bh">
          {isAgent ? <AgentId agentRef={c.agentRef} threadId={c.threadId} /> : <><Ava>me</Ava><b>You</b></>}
          {c.severity && (
            // hotspot severity badge — deliberately NOT the resolved-verdict green/
            // muted palette, so a hotspot never reads as an already-handled thread.
            <span className={`sev-badge sev-${c.severity}`} title={c.severity === 'risk' ? 'Agent-flagged risk' : 'Agent note'}>
              {c.severity}
            </span>
          )}
          <span className="dim">{locLabel}</span>
          {lastTurn === 'head' && statusChips(c.author)}
          {c.anchorEdited && c.status !== 'outdated' && (
            // The commented line itself was rewritten since the comment was made (the
            // re-anchor pipeline's stage-1 'EDITED'). The marker claims only that — where
            // the card ended up is a separate question (re-placed on the replacement code,
            // or left behind and bucketed), so the copy must not promise either.
            <span className="agentq" style={{ color: 'var(--amber)' }} title="The line this comment was written against was rewritten after the comment was made — the text it quoted is no longer in the file.">
              line edited since comment
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
              <button className="btn btn-sm btn-primary" onClick={() => { void useStore.getState().editComment(c, draft); setEditing(false) }}>Save</button>
              <button className="btn btn-sm btn-ghost" onClick={() => setEditing(false)}>Cancel</button>
            </div>
          </div>
        ) : (
          <div className="bb">{c.text}</div>
        )}
        {/* the thread, in order: replies (a folded earlier resolution among them, with
            its verdict), then the live resolution last — it is the latest turn, since a
            reviewer reply always re-queues the comment and folds it away */}
        {c.replies.map((r, i) => (
          <div key={i} className="dreply">
            <div className="bh">
              {r.author === 'agent' ? <AgentId agentRef={r.agentRef} threadId={r.threadId} /> : <><Ava>me</Ava><b>You</b></>}
              <span className="dim">{r.verdict ? verdictLabel(r.verdict) : 'replied'}</span>
              {lastTurn === 'reply' && i === c.replies.length - 1 && statusChips(r.author)}
            </div>
            <div className="bb">{r.text}</div>
          </div>
        ))}
        {showResolution && c.resolution && (
          // The resolve note IS the reply for the common case (spec B4 channel dedup) —
          // render it as a reply-styled thread entry, not just verdict metadata, so it
          // reads as the answer.
          <div className="dreply">
            <div className="bh">
              <AgentId agentRef={c.resolution.agentRef} threadId={c.threadId} />
              <span className="dim">resolution</span>
              {statusChips('agent')}
            </div>
            <div className="bb">{c.resolution.note}</div>
          </div>
        )}
        {replying && (
          <Composer
            placeholder="Reply — the thread goes back to the agent with your next batch…"
            kicker="reply"
            submitLabel="Reply"
            hint="re-queues this thread for the agent"
            onCancel={() => setReplying(false)}
            onSubmit={(text) => { void useStore.getState().replyToComment(c, text); setReplying(false) }}
          />
        )}
        {!merged && !editing && !replying && !isAgent && c.status !== 'sent' && (
          <div className="bf">
            {c.status !== 'resolved' && !confirmDel && <button onClick={() => setEditing(true)}>Edit</button>}
            {c.status === 'resolved' && <ReplyButton onClick={() => setReplying(true)} />}
            {c.status === 'resolved' && <RequeueButton c={c} />}
            {deleteControl}
          </div>
        )}
        {!merged && !editing && !replying && isAgent && (
          <div className="bf">
            {/* a hotspot the reviewer already queued needs neither — its card carries
                the queued chip and Send now instead (they would only re-queue what is
                already in the batch) */}
            {c.status !== 'queued' && <ReplyButton onClick={() => setReplying(true)} />}
            {c.status !== 'queued' && <RequeueButton c={c} />}
            {deleteControl}
          </div>
        )}
      </div>
    </div>
  )
}

/** A resolved thread — reviewer-authored or an agent hotspot — can be continued: the
 *  reply goes on the end of the thread and re-queues it (`replyToComment`), so the
 *  agent's next batch reads the whole exchange, not the original text alone (which is
 *  all Re-queue resends). */
function ReplyButton({ onClick }: { onClick: () => void }) {
  return (
    <button className="reply" onClick={onClick} title="Continue this thread — your reply re-queues it for the agent">
      <I.bubble style={{ width: 11, height: 11 }} />Reply
    </button>
  )
}

/** Inline composer. Every comment it writes is a *queued* one, folded into the next
 *  batch — `kicker`/`submitLabel`/`hint` name the turn it is being written on. */
export function Composer({ placeholder, onSubmit, onCancel, kicker, submitLabel: submitOverride, hint: hintOverride }: {
  placeholder: string
  onSubmit: (text: string) => void
  onCancel: () => void
  /** the header's role word ('new comment' by default) */
  kicker?: string
  submitLabel?: string
  hint?: string
}) {
  const [text, setText] = useState('')
  const submitLabel = submitOverride ?? 'Add comment'
  const hint = hintOverride ?? 'queues for the agent — nothing is sent yet'
  return (
    <div className="dthread">
      <div className="box">
        <div className="bh">
          <Ava>me</Ava><b>You</b>
          <span className="dim">{kicker ?? 'new comment'}</span>
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
              <I.bubble style={{ width: 12, height: 12 }} />{submitLabel}
            </button>
            <button className="btn btn-sm btn-ghost" onClick={onCancel}>Cancel</button>
            {hint && <span className="dim" style={{ fontSize: 10.5 }}>{hint}</span>}
            <span className="dim" style={{ fontSize: 10.5, marginLeft: 'auto' }}>⌘⏎ send · Esc cancel</span>
          </div>
        </div>
      </div>
    </div>
  )
}
