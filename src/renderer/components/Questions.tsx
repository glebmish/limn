import { useState } from 'react'
import { useStore } from '../store'
import { I, CmtPlus } from '../kit'
import { addComment, sendAnswers } from '../lib/comments'
import { Composer, InlineThread } from './Threads'

/** "Agent needs a decision" block — open questions from the review, answerable inline. */
export function Questions() {
  const { loaded } = useStore()
  const [answering, setAnswering] = useState<string | null>(null)
  const questions = loaded?.state.annotations?.questions ?? []
  const comments = loaded?.state.comments ?? []
  if (questions.length === 0) return null

  const isAnswered = (id: string): boolean =>
    comments.some((c) => c.anchor.kind === 'question' && c.anchor.questionId === id)
  // one + for the whole block: it opens the next still-open question (usually the
  // only one). Answering sends to the agent immediately, so it's amber, not green.
  const nextOpen = questions.find((q) => !isAnswered(q.id))

  return (
    <div className="gen-cta lr-decision-cmt" style={{ borderStyle: 'solid', borderColor: 'var(--amber-line)', background: 'var(--amber-soft)' }}>
      {nextOpen && !answering && (
        <CmtPlus extra="decision-plus" onClick={() => setAnswering(nextOpen.id)} />
      )}
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
              </div>
              {answers.map((c) => <InlineThread key={c.id} c={c} locLabel="decision" />)}
              {answering === q.id && (
                <Composer
                  sendNow
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
