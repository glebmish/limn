import { useEffect, useMemo, useRef, useState } from 'react'
import { activeChat, chatsWithDraft, checkoutGate, useStore } from '../store'
import { I, Ava, EngineGlyph } from '../kit'
import { agentLabel } from '../../shared/agents'
import type { CommentAnchor, EngineId, FocusTarget, MessageSegment, ToolCall } from '../../shared/types'
import { AgentPicker } from './AgentPicker'
import { ChatDropdown } from './ChatDropdown'
import { ActionChips } from './ActionChips'
import { ToolCallLog } from './ToolCallLog'
import { ModeSelector } from './ModeSelector'
import { ApprovalCard } from './ApprovalCard'
import { Markdown } from '../lib/markdown'
import { queuedComments } from '../lib/comments'
import { reduceToolCalls, reduceSegments } from '../../shared/toolcalls'
import type { AgentAction } from '../../shared/types'
import { dev } from '../dev'
import { focusAnchor } from '../lib/focus'
import type { Comment } from '../../shared/types'

/** Right-sidebar multi-chat panel: a list of chats tied to the review, each with
 *  its own agent. Chat 1 resumes the review agent's session; new chats can target
 *  any agent and are seeded with review context. */
export function ChatDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const store = useStore()
  const { loaded, gen, activeChatId, draftChat } = store
  const chats = useMemo(() => chatsWithDraft(loaded, draftChat), [loaded, draftChat])
  // resolve the active chat, falling back to the running op's thread so a review
  // streams into a fully-chromed chat even if selection hasn't caught up yet.
  const active = activeChat(loaded, activeChatId, draftChat)
    ?? chats.find((c) => c.id === gen.threadId)
    ?? chats[chats.length - 1] ?? null
  const latestReview = [...chats].reverse().find((c) => c.kind === 'review')
  // viewing a superseded review session (an older generation) — offer to switch
  const onOldReview = active?.kind === 'review' && latestReview != null && active.id !== latestReview.id
  // the drawer renders the chat list, so gate on whether any chat exists. The review
  // thread is created up front by beginReview, so a review chat is present from the
  // moment generation starts — no indirect iteration-count proxy, no in-progress
  // special-case. The empty hint only shows when there are genuinely no chats.
  const hasChats = chats.length > 0
  // block agent submissions while the compare branch isn't checked out anywhere —
  // edits would have nowhere safe to land (see checkoutGate).
  const gate = checkoutGate(loaded)
  const [draft, setDraft] = useState('')
  const [steer, setSteer] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  const queued = queuedComments()

  // stream the running op into whichever thread it targets — review generation and
  // chat turns both flow through this one path (routed by threadId, not kind).
  const streaming = gen.running && gen.threadId != null && gen.threadId === active?.id
  // ordered segments (text↔tool interleave) + the folded tool calls they reference;
  // rendered inline so live + persisted messages keep the agent's true call order.
  const liveSegments = streaming ? reduceSegments(gen.log) : []
  const liveCalls = streaming ? reduceToolCalls(gen.log) : []
  // a scalar that grows with every streamed event — drives the follow-scroll effect.
  const streamLen = streaming ? gen.log.length : 0
  const statusLine = streaming
    ? [...gen.log].reverse().find((e) => e.type === 'status')
    : undefined
  const liveActions: AgentAction[] = streaming
    ? gen.log.flatMap((e) => (e.type === 'action' ? [e.action] : []))
    : []
  // pending approvals: derived from the log, minus any answered this op
  const [answered, setAnswered] = useState<Set<string>>(new Set())
  useEffect(() => { setAnswered(new Set()) }, [gen.opId])
  const pendingApprovals = streaming
    ? gen.log.flatMap((e) => (e.type === 'approval_request' ? [e.request] : [])).filter((r) => !answered.has(r.id))
    : []

  // follow the stream only while parked at the bottom, so a burst of tool calls
  // doesn't yank a reader who has scrolled up. switching chats / opening jumps to
  // the bottom unconditionally. onBodyScroll re-arms following near the bottom.
  useEffect(() => {
    if (stickRef.current) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [active?.messages.length, streamLen])
  useEffect(() => {
    stickRef.current = true
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [activeChatId, open])
  const onBodyScroll = () => {
    const el = scrollRef.current
    if (el) stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 24
  }

  // dev-only: activate a specific seeded chat for screenshots
  const pinnedDev = useRef(false)
  useEffect(() => {
    const want = dev.activeChat
    if (pinnedDev.current || want == null || !chats.some((c) => c.id === want)) return
    pinnedDev.current = true
    store.switchChat(want)
  }, [chats, store])

  // dev-only: LIMN_RUN_CHAT=<text> auto-sends one chat turn (screenshot the tool-call log)
  const ranChat = useRef(false)
  useEffect(() => {
    const text = dev.runChat
    if (ranChat.current || !text || !active || gen.running) return
    ranChat.current = true
    setTimeout(() => store.sendChat(text), 400)
  }, [active, gen.running, store])

  // a11y: on open, move focus into the drawer (announced via the complementary
  // landmark on the root); on close, restore focus to whatever opened it.
  const drawerRef = useRef<HTMLDivElement>(null)
  const restoreRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (open) {
      restoreRef.current = document.activeElement as HTMLElement | null
      drawerRef.current?.focus()
    } else if (restoreRef.current) {
      restoreRef.current.focus()
      restoreRef.current = null
    }
  }, [open])

  if (!open) return null

  const send = (): void => {
    const text = draft.trim()
    if (!text || !active || streaming || gate.blocked) return
    store.sendChat(text)
    setDraft('')
  }

  return (
    <div className="chat-drawer" ref={drawerRef} role="complementary" aria-label="Chats" tabIndex={-1}>
      <div className="chat-head">
        {hasChats ? (
          <ChatDropdown chats={chats} activeId={active?.id ?? null}
            onSwitch={(id) => store.switchChat(id)} onNew={() => void store.newChat()}
            onDelete={(id) => void store.deleteChat(id)} />
        ) : (
          <>
            <I.bubble style={{ width: 13, height: 13, color: 'var(--accent)' }} />
            <b>Chats</b>
            <span className="dim" style={{ fontSize: 10.5 }}>tied to this review</span>
          </>
        )}
        <button className="btn btn-sm btn-ghost chat-head-x" aria-label="Close chats" onClick={onClose}>
          <I.x style={{ width: 11, height: 11 }} />
        </button>
      </div>

      {!hasChats ? (
        <div className="chat-body">
          <div className="chat-hint">
            Generate a guided review first. The review agent becomes your first chat — with full
            context about this branch — and you can open more chats with any agent.
          </div>
        </div>
      ) : (
        <>
          {onOldReview && latestReview && (
            <div className="chat-oldsession">
              <I.changed style={{ width: 12, height: 12 }} />
              <span>You're viewing an older review session. A newer one was generated.</span>
              <button className="btn btn-sm btn-primary" onClick={() => store.switchChat(latestReview.id)}>
                Switch to current<I.chevR style={{ width: 11, height: 11 }} />
              </button>
            </div>
          )}

          <div className="chat-body" ref={scrollRef} onScroll={onBodyScroll}>
            {active?.kind === 'review' && active.messages.length === 0 && !streaming && (
              <div className="chat-hint">
                This is the agent that wrote the review — it already has full context. Ask why it
                grouped a section that way, or what a change affects.
              </div>
            )}
            {active?.messages.map((m, i) => {
              const submittedRefs = m.role === 'user' ? (m.commentRefs ?? inferSubmittedCommentRefs(active.messages, i)) : undefined
              return (
              <div key={i} className={'chat-msg ' + m.role}>
                <Ava ai={m.role === 'agent'}>
                  {m.role === 'agent' ? <EngineGlyph engine={active?.agent.engine} style={{ width: 13, height: 13 }} /> : 'me'}
                </Ava>
                <div className="chat-bubble">
                  {m.anchor && <div className="chat-anchor">re: {describeShort(m.anchor)}</div>}
                  {m.role === 'agent' ? (
                    m.segments && m.segments.length > 0
                      ? <SegmentBody segments={m.segments} calls={m.tools ?? []} actions={m.actions ?? []} engine={active?.agent.engine} threadId={active?.id} />
                      : (
                        <>
                          {m.tools && m.tools.length > 0 && <ToolCallLog calls={m.tools} />}
                          <Markdown text={m.text} />
                        </>
                      )
                  ) : (
                    <>
                      <div>{m.text}</div>
                      {submittedRefs && submittedRefs.length > 0 && (
                        <SubmittedCommentRefs commentRefs={submittedRefs} comments={loaded?.state.comments ?? []} />
                      )}
                    </>
                  )}
                  {(!m.segments || m.segments.length === 0) && m.actions && m.actions.length > 0 && <ActionChips actions={m.actions} engine={active?.agent.engine} threadId={active?.id} />}
                </div>
              </div>
              )
            })}
            {streaming && (
              <div className="chat-msg agent" aria-live="polite">
                <Ava ai><EngineGlyph engine={active?.agent.engine} style={{ width: 13, height: 13 }} /></Ava>
                <div className="chat-bubble">
                  {liveSegments.length > 0 ? (
                    <SegmentBody segments={liveSegments} calls={liveCalls} actions={liveActions} engine={active?.agent.engine} threadId={active?.id} />
                  ) : (
                    <div className="tstatus"><span className="limn-spin" />{statusLine?.text ?? 'thinking…'}</div>
                  )}
                  {liveSegments.length === 0 && liveActions.length > 0 && <ActionChips actions={liveActions} engine={active?.agent.engine} threadId={active?.id} />}
                </div>
              </div>
            )}
          </div>

          {pendingApprovals.length > 0 && (
            <ApprovalCard
              request={pendingApprovals[0]}
              index={0}
              total={pendingApprovals.length}
              onDecide={(d) => { store.respondApproval(pendingApprovals[0].id, d); setAnswered((s) => new Set(s).add(pendingApprovals[0].id)) }}
              onStop={() => store.cancelOp()}
            />
          )}

          {active && queued.length > 0 && !streaming && (
            <div className="chat-batch">
              <button
                className="btn btn-primary btn-sm chat-batch-go"
                disabled={!gate.writeEnabled}
                onClick={() => { if (!gate.writeEnabled) return; store.sendQueuedComments(queued.map((c) => c.id), steer); setSteer('') }}
              >
                <I.send style={{ width: 12, height: 12 }} />
                Send {queued.length} pending comment{queued.length === 1 ? '' : 's'} → {agentLabel(active.agent)}
              </button>
              <input
                className="chat-steer"
                placeholder="optional steer — e.g. “fix the rounding ones, just answer the rest”"
                value={steer}
                onChange={(e) => setSteer(e.target.value)}
              />
            </div>
          )}

          {gate.blocked && (
            <div className="chat-gate block">
              <I.warn style={{ width: 12, height: 12, color: 'var(--amber)' }} />
              <span><b>{gate.branch}</b> isn't checked out — check it out in the worktree menu to enable edits.</span>
            </div>
          )}
          {gate.dirtyWarn && (
            <div className="chat-gate warn">
              <I.warn style={{ width: 12, height: 12 }} />
              <span>Uncommitted changes in the worktree — agent edits will mix with them.</span>
            </div>
          )}

          <div className="chat-foot">
            <textarea
              rows={2}
              placeholder={gate.blocked ? 'Check out the branch to chat' : active ? `Ask ${agentLabel(active.agent)}…` : 'Pick a chat'}
              disabled={!active || streaming || gate.blocked}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send() }
              }}
            />
            <button className="btn btn-primary btn-sm" disabled={!active || streaming || gate.blocked || !draft.trim()} onClick={send}>
              <I.send style={{ width: 12, height: 12 }} />
            </button>
          </div>

          {/* agent + mode live at the bottom (per the mockup): pick who answers and
              how much leash, directly under the composer. */}
          {active && (
            <div className="chat-botbar">
              <AgentPicker value={active.agent} disabled={streaming} onChange={(a) => void store.setActiveChatAgent(a)} />
              <ModeSelector
                mode={active.executionMode}
                disabled={streaming}
                onChange={(m) => void store.setChatMode(active.id, m)}
              />
            </div>
          )}
        </>
      )}
    </div>
  )
}

/** Render an agent message's ordered segments inline: prose as markdown, each tool
 *  segment as a single-row ToolCallLog (its ToolCall resolved by id against `calls`;
 *  skipped if absent). Keeps tool rows at their true call site instead of grouping. */
const ACTION_TOOL_KIND: Record<string, AgentAction['kind']> = {
  focus: 'focus',
  tour: 'tour',
  suggest_mark_viewed: 'suggest_viewed',
  add_comment: 'comment_added',
  reply_to_comment: 'comment_replied',
  resolve_comment: 'comment_resolved',
  edit_review: 'review_edited'
}

function actionToolKind(call: ToolCall): AgentAction['kind'] | null {
  const bare = call.name.replace(/^mcp__limn__/, '')
  return ACTION_TOOL_KIND[bare] ?? null
}

export function SegmentBody({ segments, calls, actions, engine, threadId }: {
  segments: MessageSegment[]
  calls: ToolCall[]
  actions: AgentAction[]
  engine?: EngineId
  threadId?: number
}) {
  const byId = new Map(calls.map((c) => [c.id, c]))
  const usedActionIndexes = new Set<number>()
  for (const seg of segments) {
    if (seg.kind === 'action') usedActionIndexes.add(seg.index)
  }
  const takeAction = (kind: AgentAction['kind']): AgentAction | null => {
    const idx = actions.findIndex((a, i) => !usedActionIndexes.has(i) && a.kind === kind)
    if (idx < 0) return null
    usedActionIndexes.add(idx)
    return actions[idx]
  }
  return (
    <>
      {segments.map((seg, i) => {
        if (seg.kind === 'text') return <Markdown key={i} text={seg.text} />
        if (seg.kind === 'tool') {
          const call = byId.get(seg.id)
          const kind = call?.state === 'ok' ? actionToolKind(call) : null
          if (kind) {
            const action = takeAction(kind)
            return action ? <ActionChips key={i} actions={[action]} engine={engine} threadId={threadId} /> : null
          }
          return call ? <ToolCallLog key={i} calls={[call]} /> : null
        }
        const action = actions[seg.index]
        return action ? <ActionChips key={i} actions={[action]} engine={engine} threadId={threadId} /> : null
      })}
    </>
  )
}

function base(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? path : path.slice(i + 1)
}

function commentRefLabel(c: Comment): string {
  const a = c.anchor
  switch (a.kind) {
    case 'diff': return `${base(a.file)}:${a.line}`
    case 'file': return base(a.file)
    case 'section': return 'section'
    case 'summary': return 'summary'
    case 'artifact': return `${base(a.path)}:${a.line}`
    case 'plan-step': return `plan ${a.stepN}`
    case 'question': return 'question'
    case 'title': return 'title'
    case 'acceptance': return `criterion ${a.index + 1}`
    case 'deviation': return `deviation ${a.index + 1}`
    case 'selection': return a.quote.length > 24 ? a.quote.slice(0, 23) + '...' : a.quote
  }
}

function focusableAnchor(anchor: CommentAnchor): FocusTarget | null {
  return anchor.kind === 'summary' || anchor.kind === 'section' || anchor.kind === 'file' || anchor.kind === 'diff' ? anchor : null
}

export function SubmittedCommentRefs({ commentRefs, comments }: { commentRefs: string[]; comments: Comment[] }) {
  const byId = new Map(comments.map((c) => [c.id, c]))
  const refs = commentRefs.map((id) => byId.get(id)).filter((c): c is Comment => Boolean(c))
  if (refs.length === 0) return null
  return (
    <div className="limn-act submit">
      <div className="limn-act-head">
        <I.arrow className="ah-ic" />
        <span className="ah-verb">Submitted</span>
        <span className="ah-anchor">{refs.length} comment{refs.length === 1 ? '' : 's'}</span>
      </div>
      <div className="limn-submit-list">
        {refs.map((c, i) => (
          <button key={c.id} className="limn-submit-ref" onClick={() => {
            const anchor = focusableAnchor(c.anchor)
            if (anchor) focusAnchor(anchor)
          }}>
            <span className="sr-n">{i + 1}</span>
            <span className="sr-body">
              <span className="sr-loc">{commentRefLabel(c)}</span>
              <span className="sr-text">{c.text}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

export function inferSubmittedCommentRefs(messages: { role: 'user' | 'agent'; text: string; actions?: AgentAction[] }[], index: number): string[] {
  const msg = messages[index]
  if (!msg || msg.role !== 'user' || !/^Handle \d+ comment\(s\)/.test(msg.text)) return []
  const next = messages.slice(index + 1).find((m) => m.role === 'agent')
  const ids = new Set<string>()
  for (const action of next?.actions ?? []) {
    if (action.kind === 'comment_replied' || action.kind === 'comment_resolved') ids.add(action.commentId)
    if (action.kind === 'comment_added') ids.add(action.comment.id)
  }
  return [...ids]
}

function describeShort(anchor: CommentAnchor): string {
  const a = anchor as { kind: string; file?: string; line?: number; path?: string; sectionId?: string }
  switch (a.kind) {
    case 'diff': return `${a.file}:${a.line}`
    case 'artifact': return `${a.path}:${a.line}`
    case 'file': return a.file ?? 'file'
    case 'section': return `section ${a.sectionId}`
    default: return a.kind
  }
}
