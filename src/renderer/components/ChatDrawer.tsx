import { useEffect, useRef, useState } from 'react'
import { newOpId, useStore } from '../store'
import { I, Ava } from '../kit'

/** Chat with the engine session that produced the review. */
export function ChatDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { loaded, repo, branch, base, gen } = useStore()
  const [draft, setDraft] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const transcript = loaded?.state.chat ?? []
  const hasSession = (loaded?.state.iterations.length ?? 0) > 0
  const streaming = gen.running && gen.kind === 'chat'
  const partial = streaming
    ? gen.log.filter((e) => e.type === 'text').map((e) => ('text' in e ? e.text : '')).join('')
    : ''

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [transcript.length, partial, open])

  if (!open) return null

  const send = (): void => {
    const text = draft.trim()
    if (!text || !repo || streaming) return
    const opId = newOpId()
    useStore.getState().startOp('chat', opId)
    setDraft('')
    void window.api.chat(repo, branch, base, text, opId)
  }

  return (
    <div className="chat-drawer">
      <div className="chat-head">
        <I.bubble style={{ width: 13, height: 13, color: 'var(--accent)' }} />
        <b>Ask the agent</b>
        <span className="dim" style={{ fontSize: 10.5 }}>same session as the review</span>
        <button className="btn btn-sm btn-ghost" style={{ marginLeft: 'auto' }} onClick={onClose}>
          <I.x style={{ width: 11, height: 11 }} />
        </button>
      </div>
      <div className="chat-body" ref={scrollRef}>
        {!hasSession && (
          <div className="chat-hint">
            Generate a guided review first — chat shares the agent&apos;s session, so it answers with
            full context about this branch.
          </div>
        )}
        {transcript.map((m, i) => (
          <div key={i} className={'chat-msg ' + m.role}>
            <Ava ai={m.role === 'agent'}>{m.role === 'agent' ? 'AI' : 'me'}</Ava>
            <div className="chat-bubble">
              {m.anchor && <div className="chat-anchor">re: {describeShort(m.anchor)}</div>}
              {m.text}
            </div>
          </div>
        ))}
        {streaming && (
          <div className="chat-msg agent">
            <Ava ai>AI</Ava>
            <div className="chat-bubble">{partial || <span className="dim">thinking…</span>}</div>
          </div>
        )}
      </div>
      <div className="chat-foot">
        <textarea
          rows={2}
          placeholder={hasSession ? 'Why did the agent…? What calls this…?' : 'Generate a review first'}
          disabled={!hasSession || streaming}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
        />
        <button className="btn btn-primary btn-sm" disabled={!hasSession || streaming || !draft.trim()} onClick={send}>
          <I.send style={{ width: 12, height: 12 }} />
        </button>
      </div>
    </div>
  )
}

function describeShort(anchor: NonNullable<ReturnType<typeof Object>['anchor']> | { kind: string;[k: string]: unknown }): string {
  const a = anchor as { kind: string; file?: string; line?: number; path?: string; sectionId?: string }
  switch (a.kind) {
    case 'diff': return `${a.file}:${a.line}`
    case 'artifact': return `${a.path}:${a.line}`
    case 'file': return a.file ?? 'file'
    case 'section': return `section ${a.sectionId}`
    default: return a.kind
  }
}
