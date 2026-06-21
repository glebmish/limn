import { useState } from 'react'
import { useStore } from '../store'
import { I } from '../kit'
import { addComment, sendAnswers } from '../lib/comments'
import { Composer, InlineThread } from './Threads'

/** "Agent needs a decision" block — open questions from the review, answerable inline. */
export function Questions() {
  const { loaded } = useStore()
  const [answering, setAnswering] = useState<string | null>(null)
  const questions = loaded?.state.annotations?.questions ?? []
  const comments = loaded?.state.comments ?? []
  if (questions.length === 0) return null

  return (
    <div className="gen-cta" style={{ borderStyle: 'solid', borderColor: 'var(--amber-line)', background: 'var(--amber-soft)' }}>
      <div style={{ flex: '1 1 100%' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, fontWeight: 700, color: 'var(--amber)', marginBottom: 6 }}>
          <I.flag style={{ width: 12, height: 12 }} />Agent needs a decision
        </div>
        {questions.map((q) => {
          const answers = comments.filter((c) => c.anchor.kind === 'question' && c.anchor.questionId === q.id)
          return (
            <div key={q.id} style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 12.5, color: 'var(--ink-2)', lineHeight: 1.5 }}>
                • {q.text}
                {q.context && <span className="dim" style={{ marginLeft: 6, fontSize: 11 }}>({q.context})</span>}
                {answers.length === 0 && answering !== q.id && (
                  <button className="gfile-regen" style={{ marginLeft: 8 }} onClick={() => setAnswering(q.id)}>
                    <I.bubble style={{ width: 11, height: 11 }} />Answer
                  </button>
                )}
              </div>
              {answers.map((c) => <InlineThread key={c.id} c={c} locLabel="decision" />)}
              {answering === q.id && (
                <Composer
                  placeholder="Your decision — the agent folds it into the review (no code changes)…"
                  onCancel={() => setAnswering(null)}
                  onSubmit={(text) => {
                    void addComment({ kind: 'question', questionId: q.id }, text).then((id) => { if (id) sendAnswers([id]) })
                    setAnswering(null)
                  }}
                />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
