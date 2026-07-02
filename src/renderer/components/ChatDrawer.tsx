import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { activeChat, chatsWithDraft, checkoutGate, opForThread, genSessionLost, pendingApprovals, useStore } from '../store'
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
import type { ChatMessage as ChatMsg, Comment } from '../../shared/types'

/** Default number of trailing messages the drawer mounts; each "Show earlier" click
 *  reveals another window of this size. A single knob per spec §4 (Q6). */
const CHAT_WINDOW = 100
/** Stable empty fallback so the memoized ChatMessage's `comments` prop keeps identity
 *  across streaming re-renders (a fresh `[]` each render would defeat the memo). */
const EMPTY_COMMENTS: Comment[] = []
/** Stable empty fallback for a chat with no messages, so `windowMessages` and the
 *  submitted-refs memo key on a constant identity rather than a fresh `[]` each render. */
const EMPTY_MESSAGES: ChatMsg[] = []

/** Pure slice arithmetic for the message window: mount only the last `shown` messages,
 *  reporting how many older ones are hidden (0 → no "Show earlier" button) and the
 *  index offset of the first visible message (so callers can key by real index). */
export function windowMessages<T>(messages: T[], shown: number): { start: number; visible: T[]; hidden: number } {
  const start = Math.max(0, messages.length - shown)
  return { start, visible: messages.slice(start), hidden: start }
}

/** Right-sidebar multi-chat panel: a list of chats tied to the review, each with
 *  its own agent. Chat 1 resumes the review agent's session; new chats can target
 *  any agent and are seeded with review context. */
export function ChatDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const store = useStore()
  const { loaded, ops, activeChatId, draftChat } = store
  const chats = useMemo(() => chatsWithDraft(loaded, draftChat), [loaded, draftChat])
  // resolve the active chat, falling back to a thread currently streaming an op so a
  // review streams into a fully-chromed chat even if selection hasn't caught up yet.
  const active = activeChat(loaded, activeChatId, draftChat)
    ?? chats.find((c) => opForThread(ops, c.id).running)
    ?? chats[chats.length - 1] ?? null
  // the op (if any) streaming into the ACTIVE thread — one op per thread. Every live
  // stream / approval / session-lost signal below is scoped to this, so two concurrent
  // ops on different threads never cross-render.
  const op = opForThread(ops, active?.id)
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

  // windowing: mount only the last `shown` messages so a long thread (chat history
  // accumulates forever in the DB) doesn't re-render N markdown parses per event.
  // Reset to one window whenever the active chat changes.
  const [shown, setShown] = useState(CHAT_WINDOW)
  useEffect(() => { setShown(CHAT_WINDOW) }, [activeChatId])
  const messages = active?.messages ?? EMPTY_MESSAGES
  const { start, visible, hidden } = windowMessages(messages, shown)
  // submitted-comment refs for every message, keyed on the (stable-between-streams)
  // messages array, so each entry keeps a stable identity and the memoized ChatMessage
  // rows don't re-render on unrelated events. Passed per-row as a prop.
  const submittedRefsByIndex = useMemo(
    () => messages.map((m, i) => m.role === 'user' ? (m.commentRefs ?? inferSubmittedCommentRefs(messages, i)) : undefined),
    [messages]
  )
  // scroll anchoring: "Show earlier" prepends older rows above the viewport; capture
  // scrollHeight before the prepend and re-add the delta after layout so the reader
  // stays put instead of being yanked to the top.
  const anchorRef = useRef<number | null>(null)
  const showEarlier = (): void => {
    anchorRef.current = scrollRef.current?.scrollHeight ?? null
    setShown((s) => s + CHAT_WINDOW)
  }
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && anchorRef.current != null) {
      el.scrollTop += el.scrollHeight - anchorRef.current
      anchorRef.current = null
    }
  }, [shown])

  // stream the active thread's op into it — review generation and chat turns both flow
  // through this one path (the op is already thread-scoped, so no kind check needed).
  const streaming = op.running
  // a lost-engine-session failure on this thread: the CLI pruned the session, so the
  // turn can't be retried in place. Surface a distinct banner pointing at a new chat
  // (the thread's visible history is intact — nothing was mutated on the failure path).
  const sessionLost = !op.running && op.opId != null && genSessionLost(op)
  // op.error is "<human message>\n\n<raw engine error>". Show the human line as the
  // headline and keep the raw engine error visible as a muted detail — over-classified
  // causes (e.g. a dirty tree) must stay diagnosable (spec §7).
  const [sessionLostMsg, sessionLostDetail] = sessionLost
    ? (() => { const [head, ...rest] = (op.error ?? '').split('\n\n'); return [head, rest.join('\n\n')] as const })()
    : ['', '']
  // ordered segments (text↔tool interleave) + the folded tool calls they reference;
  // rendered inline so live + persisted messages keep the agent's true call order.
  // Memoized on [streaming, op.log]: the log is a fresh array per event (so this still
  // recomputes per event, bounded by the 200-cap) but stops re-reducing on unrelated
  // renders — draft typing, scroll state, window changes.
  const { liveSegments, liveCalls } = useMemo(
    () => streaming
      ? { liveSegments: reduceSegments(op.log), liveCalls: reduceToolCalls(op.log) }
      : { liveSegments: [] as MessageSegment[], liveCalls: [] as ToolCall[] },
    [streaming, op.log]
  )
  // a scalar that grows with every streamed event — drives the follow-scroll effect.
  const streamLen = streaming ? op.log.length : 0
  const { statusLine, liveActions } = useMemo(
    () => streaming
      ? {
          statusLine: [...op.log].reverse().find((e) => e.type === 'status'),
          liveActions: op.log.flatMap((e) => (e.type === 'action' ? [e.action] : [])) as AgentAction[],
        }
      : { statusLine: undefined, liveActions: [] as AgentAction[] },
    [streaming, op.log]
  )
  // pending approvals for the ACTIVE thread's op → the full card below. Un-gated from
  // `streaming` so a parked approval stays answerable. A parked approval on a DIFFERENT
  // thread (e.g. the generation asks while you read another chat) surfaces as a compact
  // deep-link nudge instead (concurrent-chat §5).
  const pending = pendingApprovals(op)
  const otherApprovalThread = chats.find((c) => c.id !== active?.id && pendingApprovals(opForThread(ops, c.id)).length > 0)?.id ?? null

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
    if (ranChat.current || !text || !active || op.running) return
    ranChat.current = true
    setTimeout(() => store.sendChat(text), 400)
  }, [active, op.running, store])

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
            {hidden > 0 && (
              <button className="chat-earlier" onClick={showEarlier}>
                Show earlier messages ({hidden} hidden)
              </button>
            )}
            {visible.map((m, i) => {
              const idx = start + i
              return (
                <ChatMessage
                  key={idx}
                  m={m}
                  submittedRefs={submittedRefsByIndex[idx]}
                  engine={active?.agent.engine}
                  threadId={active?.id}
                  comments={loaded?.state.comments ?? EMPTY_COMMENTS}
                />
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

          {pending.length > 0 && op.opId != null ? (
            // full card on the active thread — Approve/Deny/Stop route to this op
            <ApprovalCard
              request={pending[0]}
              index={0}
              total={pending.length}
              onDecide={(d) => store.respondApproval(op.opId!, pending[0].id, d)}
              onStop={() => store.cancelOp(op.opId!)}
            />
          ) : otherApprovalThread != null && (
            // an approval parked on another thread (e.g. the generation): a compact
            // amber nudge that deep-links to it, where the full card renders.
            <div className="chat-oldsession chat-approval-nudge" role="alert">
              <I.warn style={{ width: 12, height: 12 }} />
              <span>The review agent is waiting on an approval.</span>
              <button className="btn btn-sm btn-primary" onClick={() => store.switchChat(otherApprovalThread)}>
                Go to approval<I.chevR style={{ width: 11, height: 11 }} />
              </button>
            </div>
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

          {sessionLost && (
            <div className="chat-gate block" role="alert">
              <I.warn style={{ width: 12, height: 12, color: 'var(--amber)' }} />
              <span>
                {sessionLostMsg}
                {sessionLostDetail && <small style={{ display: 'block', opacity: 0.6, marginTop: 2 }}>{sessionLostDetail}</small>}
              </span>
              <button className="btn btn-primary btn-sm" style={{ marginLeft: 'auto' }} onClick={() => void store.newChat()}>
                <I.plus style={{ width: 12, height: 12 }} />
                Start a new chat
              </button>
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

/** One chat row, memoized. Persisted message objects have stable identities between
 *  streams (they only change on reload), and every prop here is either that object or a
 *  primitive / stable reference (`submittedRefs` from a messages-keyed memo, `comments`
 *  a store reference with an EMPTY fallback), so `memo` skips re-rendering — and thus
 *  re-parsing markdown for — every settled message on each streamed event. */
const ChatMessage = memo(function ChatMessage({ m, submittedRefs, engine, threadId, comments }: {
  m: ChatMsg
  submittedRefs: string[] | undefined
  engine?: EngineId
  threadId?: number
  comments: Comment[]
}) {
  return (
    <div className={'chat-msg ' + m.role}>
      <Ava ai={m.role === 'agent'}>
        {m.role === 'agent' ? <EngineGlyph engine={engine} style={{ width: 13, height: 13 }} /> : 'me'}
      </Ava>
      <div className="chat-bubble">
        {m.anchor && <div className="chat-anchor">re: {describeShort(m.anchor)}</div>}
        {m.role === 'agent' ? (
          m.segments && m.segments.length > 0
            ? <SegmentBody segments={m.segments} calls={m.tools ?? []} actions={m.actions ?? []} engine={engine} threadId={threadId} />
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
              <SubmittedCommentRefs commentRefs={submittedRefs} comments={comments} />
            )}
          </>
        )}
        {(!m.segments || m.segments.length === 0) && m.actions && m.actions.length > 0 && <ActionChips actions={m.actions} engine={engine} threadId={threadId} />}
      </div>
    </div>
  )
})

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
