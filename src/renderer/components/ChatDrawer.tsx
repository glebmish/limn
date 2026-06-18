import { useEffect, useRef, useState } from 'react'
import { activeChat, useStore } from '../store'
import { I, Ava } from '../kit'
import { agentLabel, engineLabel } from '../../shared/agents'
import type { ChatThread, CommentAnchor } from '../../shared/types'
import { AgentPicker } from './AgentPicker'
import { Markdown } from '../lib/markdown'

/** Right-sidebar multi-chat panel: a list of chats tied to the review, each with
 *  its own agent. Chat 1 resumes the review agent's session; new chats can target
 *  any agent and are seeded with review context. */
export function ChatDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const store = useStore()
  const { loaded, gen, activeChatId } = store
  const chats = loaded?.state.chats ?? []
  const active = activeChat(loaded, activeChatId) ?? chats[chats.length - 1] ?? null
  const hasReview = (loaded?.state.iterations.length ?? 0) > 0
  const [draft, setDraft] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  const streaming = gen.running && gen.kind === 'chat' && gen.threadId === active?.id
  const partial = streaming
    ? gen.log.filter((e) => e.type === 'text').map((e) => ('text' in e ? e.text : '')).join('')
    : ''
  const activity = streaming ? gen.log.filter((e) => e.type === 'tool' || e.type === 'status') : []

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [active?.messages.length, partial, activeChatId, open])

  if (!open) return null

  const send = (): void => {
    const text = draft.trim()
    if (!text || !active || streaming) return
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
          <div className="chat-tabs" role="tablist">
            {chats.map((c) => (
              <button
                key={c.id}
                role="tab"
                aria-selected={c.id === active?.id}
                className={'chat-tab' + (c.id === active?.id ? ' on' : '')}
                onClick={() => store.switchChat(c.id)}
                title={agentLabel(c.agent)}
              >
                <span className={'ct-dot ' + c.kind} />
                {tabLabel(c)}
              </button>
            ))}
            <button className="chat-tab new" onClick={() => void store.newChat()} title="New chat">
              <I.plus style={{ width: 12, height: 12 }} />
            </button>
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

          <div className="chat-body" ref={scrollRef}>
            {active?.kind === 'review' && active.messages.length === 0 && !streaming && (
              <div className="chat-hint">
                This is the agent that wrote the review — it already has full context. Ask why it
                flagged something, or what a change affects.
              </div>
            )}
            {active?.messages.map((m, i) => (
              <div key={i} className={'chat-msg ' + m.role}>
                <Ava ai={m.role === 'agent'}>{m.role === 'agent' ? 'AI' : 'me'}</Ava>
                <div className="chat-bubble">
                  {m.anchor && <div className="chat-anchor">re: {describeShort(m.anchor)}</div>}
                  {m.role === 'agent' ? <Markdown text={m.text} /> : m.text}
                </div>
              </div>
            ))}
            {streaming && (
              <div className="chat-msg agent">
                <Ava ai>AI</Ava>
                <div className="chat-bubble">
                  {activity.length > 0 && (
                    <div className="chat-activity">
                      {activity.slice(-4).map((e, i) => (
                        <div key={i} className={'ca-line' + (e.type === 'tool' ? ' tool' : '')}>
                          {e.type === 'tool' ? '⌁ ' : '· '}{'text' in e ? e.text : ''}
                        </div>
                      ))}
                    </div>
                  )}
                  {partial ? <Markdown text={partial} /> : <span className="dim">thinking…</span>}
                </div>
              </div>
            )}
          </div>

          <div className="chat-foot">
            <textarea
              rows={2}
              placeholder={active ? `Ask ${agentLabel(active.agent)}…` : 'Pick a chat'}
              disabled={!active || streaming}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
              }}
            />
            <button className="btn btn-primary btn-sm" disabled={!active || streaming || !draft.trim()} onClick={send}>
              <I.send style={{ width: 12, height: 12 }} />
            </button>
          </div>
        </>
      )}
    </div>
  )
}

function tabLabel(c: ChatThread): string {
  if (c.kind === 'review') return 'Review agent'
  const model = c.agent.model ?? 'Auto'
  return `${engineLabel(c.agent.engine)} · ${model}`
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
