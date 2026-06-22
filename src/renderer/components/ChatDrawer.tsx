import { useEffect, useRef, useState } from 'react'
import { activeChat, checkoutGate, useStore } from '../store'
import { I, Ava } from '../kit'
import { agentLabel } from '../../shared/agents'
import type { CommentAnchor } from '../../shared/types'
import { AgentPicker } from './AgentPicker'
import { ChatDropdown } from './ChatDropdown'
import { ActionChips } from './ActionChips'
import { ToolCallLog } from './ToolCallLog'
import { ModeSelector } from './ModeSelector'
import { ApprovalCard } from './ApprovalCard'
import { Markdown } from '../lib/markdown'
import { queuedComments } from '../lib/comments'
import { reduceToolCalls } from '../../shared/toolcalls'
import type { AgentAction } from '../../shared/types'

/** Right-sidebar multi-chat panel: a list of chats tied to the review, each with
 *  its own agent. Chat 1 resumes the review agent's session; new chats can target
 *  any agent and are seeded with review context. */
export function ChatDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const store = useStore()
  const { loaded, gen, activeChatId } = store
  const chats = loaded?.state.chats ?? []
  const active = activeChat(loaded, activeChatId) ?? chats[chats.length - 1] ?? null
  const latestReview = [...chats].reverse().find((c) => c.kind === 'review')
  // viewing a superseded review session (an older generation) — offer to switch
  const onOldReview = active?.kind === 'review' && latestReview != null && active.id !== latestReview.id
  const hasReview = (loaded?.state.iterations.length ?? 0) > 0
  // a review (re)generation is running — surface it in the open sidebar; the fresh
  // session opens here automatically when it completes (see store.reload).
  const regenerating = gen.running && gen.kind === 'review'
  // block agent submissions while the compare branch isn't checked out anywhere —
  // edits would have nowhere safe to land (see checkoutGate).
  const gate = checkoutGate(loaded)
  const [draft, setDraft] = useState('')
  const [steer, setSteer] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const queued = queuedComments()

  const streaming = gen.running && gen.kind === 'chat' && gen.threadId === active?.id
  const partial = streaming
    ? gen.log.filter((e) => e.type === 'text').map((e) => ('text' in e ? e.text : '')).join('')
    : ''
  const liveCalls = streaming ? reduceToolCalls(gen.log) : []
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

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [active?.messages.length, partial, activeChatId, open])

  // dev-only: activate a specific seeded chat for screenshots
  const pinnedDev = useRef(false)
  useEffect(() => {
    const want = window.lrDev?.activeChat
    if (pinnedDev.current || want == null || !chats.some((c) => c.id === want)) return
    pinnedDev.current = true
    store.switchChat(want)
  }, [chats, store])

  // dev-only: LR_RUN_CHAT=<text> auto-sends one chat turn (screenshot the tool-call log)
  const ranChat = useRef(false)
  useEffect(() => {
    const text = window.lrDev?.runChat
    if (ranChat.current || !text || !active || gen.running) return
    ranChat.current = true
    setTimeout(() => store.sendChat(text), 400)
  }, [active, gen.running, store])

  if (!open) return null

  const send = (): void => {
    const text = draft.trim()
    if (!text || !active || streaming || gate.blocked) return
    store.sendChat(text)
    setDraft('')
  }

  return (
    <div className="chat-drawer">
      <div className="chat-head">
        <I.bubble style={{ width: 13, height: 13, color: 'var(--accent)' }} />
        <b>Chats</b>
        <span className="dim" style={{ fontSize: 10.5 }}>tied to this review</span>
        <button className="btn btn-sm btn-ghost" style={{ marginLeft: 'auto' }} onClick={onClose}>
          <I.x style={{ width: 11, height: 11 }} />
        </button>
      </div>

      {!hasReview ? (
        <div className="chat-body">
          <div className="chat-hint">
            Generate a guided review first. The review agent becomes your first chat — with full
            context about this branch — and you can open more chats with any agent.
          </div>
        </div>
      ) : (
        <>
          <div className="chat-select">
            <ChatDropdown chats={chats} activeId={active?.id ?? null}
              onSwitch={(id) => store.switchChat(id)} onNew={() => void store.newChat()} />
          </div>

          {active && (
            <div className="chat-agentbar">
              <span className="dim ca-lab">{active.kind === 'review' ? 'Review agent' : 'Agent'}</span>
              <AgentPicker value={active.agent} disabled={streaming} onChange={(a) => void store.setActiveChatAgent(a)} />
              {active.kind === 'user' && (
                <button className="btn btn-sm btn-ghost ca-del" title="Delete chat" onClick={() => void store.deleteChat(active.id)}>
                  <I.trash style={{ width: 12, height: 12 }} />
                </button>
              )}
            </div>
          )}

          {regenerating && (
            <div className="chat-regen">
              <span className="gen-spinner" />
              <span>Regenerating the review… the new session opens here when it's ready.</span>
            </div>
          )}

          {onOldReview && latestReview && !regenerating && (
            <div className="chat-oldsession">
              <I.changed style={{ width: 12, height: 12 }} />
              <span>You're viewing an older review session. A newer one was generated.</span>
              <button className="btn btn-sm btn-primary" onClick={() => store.switchChat(latestReview.id)}>
                Switch to current<I.chevR style={{ width: 11, height: 11 }} />
              </button>
            </div>
          )}

          <div className="chat-body" ref={scrollRef}>
            {active?.kind === 'review' && active.messages.length === 0 && !streaming && (
              <div className="chat-hint">
                This is the agent that wrote the review — it already has full context. Ask why it
                grouped a section that way, or what a change affects.
              </div>
            )}
            {active?.messages.map((m, i) => (
              <div key={i} className={'chat-msg ' + m.role}>
                <Ava ai={m.role === 'agent'}>{m.role === 'agent' ? 'AI' : 'me'}</Ava>
                <div className="chat-bubble">
                  {m.anchor && <div className="chat-anchor">re: {describeShort(m.anchor)}</div>}
                  {m.role === 'agent' && m.tools && m.tools.length > 0 && <ToolCallLog calls={m.tools} />}
                  {m.role === 'agent' ? <Markdown text={m.text} /> : m.text}
                  {m.actions && m.actions.length > 0 && <ActionChips actions={m.actions} engine={active?.agent.engine} />}
                </div>
              </div>
            ))}
            {streaming && (
              <div className="chat-msg agent">
                <Ava ai>AI</Ava>
                <div className="chat-bubble">
                  <ToolCallLog calls={liveCalls} />
                  {partial ? <Markdown text={partial} /> : (
                    <div className="tstatus"><span className="lr-spin" />{statusLine?.text ?? 'thinking…'}</div>
                  )}
                  {liveActions.length > 0 && <ActionChips actions={liveActions} engine={active?.agent.engine} />}
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
                disabled={gate.blocked}
                onClick={() => { if (gate.blocked) return; store.sendBatch(active.id, queued.map((c) => c.id), steer); setSteer('') }}
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

          {active && (
            <ModeSelector
              mode={active.executionMode}
              disabled={streaming}
              onChange={(m) => void store.setChatMode(active.id, m)}
            />
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
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
              }}
            />
            <button className="btn btn-primary btn-sm" disabled={!active || streaming || gate.blocked || !draft.trim()} onClick={send}>
              <I.send style={{ width: 12, height: 12 }} />
            </button>
          </div>
        </>
      )}
    </div>
  )
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
