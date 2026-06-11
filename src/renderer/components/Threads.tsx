import { useState } from 'react'
import type { Comment } from '../../shared/types'
import { I, Ava } from '../kit'
import { deleteComment, editComment, sendComments } from '../lib/comments'

const VERDICT_ICON = { addressed: '✓', reworked: '↻', skipped: '✗' } as const

export function InlineThread({ c, locLabel }: { c: Comment; locLabel: string }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(c.text)

  return (
    <div className="dthread">
      <div className="box">
        <div className="bh">
          <Ava>me</Ava><b>You</b><span className="dim">{locLabel}</span>
          {c.status === 'queued' && (
            <>
              <span className="agentq"><I.spark style={{ width: 11, height: 11 }} />queued for agent</span>
              <button className="send-now" onClick={() => sendComments([c.id])}>
                <I.send style={{ width: 11, height: 11 }} />Send now
              </button>
            </>
          )}
          {c.status === 'sent' && <span className="agentq"><I.changed style={{ width: 11, height: 11 }} />with agent…</span>}
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
            <I.spark style={{ width: 10, height: 10, color: 'var(--accent)', marginRight: 5 }} />
            {c.resolution.note}
          </div>
        )}
        {!editing && c.status !== 'sent' && (
          <div className="bf">
            {c.status !== 'resolved' && <button onClick={() => setEditing(true)}>Edit</button>}
            <button onClick={() => void deleteComment(c.id)}>Delete</button>
          </div>
        )}
      </div>
    </div>
  )
}

export function Composer({ placeholder, onSubmit, onCancel }: {
  placeholder: string
  onSubmit: (text: string) => void
  onCancel: () => void
}) {
  const [text, setText] = useState('')
  return (
    <div className="dthread">
      <div className="box">
        <div className="bh"><Ava>me</Ava><b>You</b><span className="dim">new comment</span></div>
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
              <I.bubble style={{ width: 12, height: 12 }} />Add comment
            </button>
            <button className="btn btn-sm btn-ghost" onClick={onCancel}>Cancel</button>
            <span className="dim" style={{ fontSize: 10.5 }}>queues for the agent — nothing is sent yet</span>
          </div>
        </div>
      </div>
    </div>
  )
}
