import { useEffect, useMemo, useState } from 'react'
import type { AgentAction, AgentQuestion, ChatThread, Comment } from '../../shared/types'
import { agentLabel } from '../../shared/agents'
import { genForLoaded, useStore } from '../store'
import { I, EngineGlyph } from '../kit'
import { addComment, currentReviewChat, editComment, sendAnswers } from '../lib/comments'

interface DecisionRow {
  question: AgentQuestion
  latest?: Comment
  resolved?: Comment
  queued?: Comment
}

const EMPTY_QUESTIONS: AgentQuestion[] = []
const EMPTY_COMMENTS: Comment[] = []

function questionComments(comments: Comment[], questionId: string): Comment[] {
  return comments.filter((c) => c.anchor.kind === 'question' && c.anchor.questionId === questionId && c.status !== 'outdated')
}

function latestComment(comments: Comment[]): Comment | undefined {
  return comments[comments.length - 1]
}

function decisionLabel(question: AgentQuestion): string {
  if (question.context) return question.context
  const firstClause = question.text.split(/[?.—-]/)[0]?.trim()
  return firstClause && firstClause.length <= 32 ? firstClause : question.id
}

function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many
}

function reviewEditTargetCount(chats: ChatThread[]): number {
  const edits = chats
    .flatMap((c) => c.messages)
    .flatMap((m) => m.actions ?? [])
    .filter((a): a is Extract<AgentAction, { kind: 'review_edited' }> => a.kind === 'review_edited')
  return new Set(edits.map((a) => a.sectionId ? `section:${a.sectionId}` : a.field)).size
}

function progressStep(log: ReturnType<typeof useStore.getState>['gen']['log']): number {
  const sawReviewEdit = log.some((event) => event.type === 'action' && event.action.kind === 'review_edited')
  const sawText = log.some((event) => event.type === 'text')
  const sawTool = log.some((event) => event.type === 'tool')
  if (sawReviewEdit || sawText) return 2
  if (sawTool) return 1
  return 0
}

/** "Agent needs decisions" block — open intent questions from the review, answered as one refine turn. */
export function Questions() {
  const loaded = useStore((s) => s.loaded)
  const rawGen = useStore((s) => s.gen)
  const openChat = useStore((s) => s.openChat)
  const gen = genForLoaded(rawGen, loaded)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [adding, setAdding] = useState(false)
  const [activeCommentIds, setActiveCommentIds] = useState<string[]>([])

  const questions = loaded?.state.annotations?.questions ?? EMPTY_QUESTIONS
  const comments = loaded?.state.comments ?? EMPTY_COMMENTS
  const reviewChat = currentReviewChat(loaded?.state.chats ?? [])
  const reviewAgent = loaded?.state.agent

  const rows = useMemo<DecisionRow[]>(() => questions.map((question) => {
    const qComments = questionComments(comments, question.id)
    return {
      question,
      latest: latestComment(qComments),
      resolved: latestComment(qComments.filter((c) => c.status === 'resolved')),
      queued: latestComment(qComments.filter((c) => c.status === 'queued'))
    }
  }), [comments, questions])

  const openRows = rows.filter((row) => !row.resolved)
  const resolvedRows = rows.filter((row) => row.resolved)
  const allDone = rows.length > 0 && rows.every((row) => row.resolved)
  const runningThisTurn = (adding || gen.running) && activeCommentIds.length > 0
  const step = progressStep(gen.log)
  const progress = step === 0 ? '22%' : step === 1 ? '64%' : '100%'
  const answeredCount = openRows.filter((row) => answers[row.question.id]?.trim()).length
  const ready = openRows.length > 0 && answeredCount === openRows.length && !adding && !gen.running && Boolean(reviewChat)
  const updatedTargets = loaded ? reviewEditTargetCount(loaded.state.chats) : 0

  const answerSignature = rows.map((row) => `${row.question.id}:${row.latest?.id ?? ''}:${row.latest?.text ?? ''}:${row.resolved?.id ?? ''}`).join('|')
  useEffect(() => {
    setAnswers((prev) => {
      const next: Record<string, string> = {}
      for (const row of openRows) next[row.question.id] = prev[row.question.id] ?? row.latest?.text ?? ''
      return next
    })
    // answerSignature intentionally captures the row identities/text without
    // replacing in-progress typing on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answerSignature])

  useEffect(() => {
    if (!gen.running && !adding && activeCommentIds.length > 0) setActiveCommentIds([])
  }, [activeCommentIds.length, adding, gen.running])

  if (questions.length === 0) return null

  const submit = (): void => {
    if (!ready || !loaded || !reviewChat) return
    setAdding(true)
    void (async () => {
      const ids: string[] = []
      for (const row of openRows) {
        const text = answers[row.question.id]?.trim()
        if (!text) continue
        if (row.queued) {
          if (row.queued.text !== text) await editComment(row.queued, text)
          ids.push(row.queued.id)
        } else {
          const id = await addComment({ kind: 'question', questionId: row.question.id }, text)
          if (id) ids.push(id)
        }
      }
      if (ids.length > 0) {
        setActiveCommentIds(ids)
        sendAnswers(ids)
      }
      setAdding(false)
    })()
  }

  const setAnswer = (id: string, text: string): void => {
    setAnswers((prev) => ({ ...prev, [id]: text }))
  }

  if (runningThisTurn) {
    const label = reviewAgent ? agentLabel(reviewAgent) : 'Review agent'
    const steps = [
      `Recording ${activeCommentIds.length || openRows.length} ${plural(activeCommentIds.length || openRows.length, 'decision')} on the review`,
      'Checking the affected context',
      'Re-narrating the affected sections'
    ]
    return (
      <div className="gen-cta limn-decision-cmt decision-card is-work">
        <div className="dc-work">
          <div className="dc-prow">
            <span className="dc-spin"></span>
            <b>Following up with the review agent...</b>
            <span className="dc-model"><EngineGlyph engine={reviewAgent?.engine} />{label}</span>
          </div>
          <div className="dc-bar"><i style={{ width: progress }}></i></div>
          <div className="dc-steps">
            {steps.map((text, i) => (
              <div key={text} className={'dc-step' + (i < step ? ' ok' : i === step ? ' on' : '')}>
                <span className="dc-sdot"><I.check /></span>{text}
              </div>
            ))}
          </div>
        </div>
      </div>
    )
  }

  if (allDone) {
    const doneTitle = updatedTargets > 0
      ? `Decisions recorded - agent updated ${updatedTargets} ${plural(updatedTargets, 'area')}`
      : 'Decisions recorded'
    return (
      <div className="gen-cta limn-decision-cmt decision-card is-done">
        <div className="dc-resolved">
          <div className="dc-prow">
            <span className="dc-okic"><I.check /></span><b>{doneTitle}</b>
          </div>
          <div className="dc-recap">
            {rows.map((row) => (
              <div className="dc-rline" key={row.question.id}>
                <span className="dc-rq">{decisionLabel(row.question)}</span>
                <span className="dc-ra">{row.resolved?.text ?? row.latest?.text ?? '-'}</span>
              </div>
            ))}
          </div>
          <div className="dc-foot dc-foot-done">
            <button className="dc-chat" onClick={() => openChat(reviewChat?.id)}>
              <I.bubble />Open chat with the agent
            </button>
            <span className="grow"></span>
            <span className="dc-count">{resolvedRows.length}/{rows.length} resolved</span>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="gen-cta limn-decision-cmt decision-card">
      <div className="dc-ask">
        <div className="dc-head">
          <I.flag />Agent needs {openRows.length} {plural(openRows.length, 'decision')}
          {resolvedRows.length > 0 && <span className="dc-sub">{resolvedRows.length} already resolved</span>}
        </div>
        <div className="dc-list">
          {openRows.map((row) => {
            const { question } = row
            const options = question.options ?? []
            const answer = answers[question.id] ?? ''
            const optionSet = new Set(options)
            const customValue = answer && !optionSet.has(answer) ? answer : ''
            return (
              <div className="dc-q" key={question.id}>
                <div className="dc-qtx">
                  {question.text}
                  {question.context && <span className="dc-ref">{question.context}</span>}
                </div>
                {options.length > 0 ? (
                  <>
                    <div className="dc-opts" role="radiogroup" aria-label={question.text}>
                      {options.map((option) => (
                        <button
                          key={option}
                          type="button"
                          className={'dc-opt' + (answer === option ? ' sel' : '')}
                          onClick={() => setAnswer(question.id, option)}
                        >
                          <span className="dc-tick"><I.check /></span>{option}
                        </button>
                      ))}
                    </div>
                    <input
                      className="dc-custom"
                      value={customValue}
                      onChange={(e) => setAnswer(question.id, e.target.value)}
                      placeholder="or type another decision"
                      aria-label={`Custom answer for ${question.text}`}
                    />
                  </>
                ) : (
                  <textarea
                    className="dc-free"
                    value={answer}
                    onChange={(e) => setAnswer(question.id, e.target.value)}
                    placeholder="Your decision"
                    rows={2}
                  />
                )}
              </div>
            )
          })}
        </div>
        <div className="dc-foot">
          <button type="button" className="dc-submit" disabled={!ready} onClick={submit}>
            <I.arrow />Send answers to the agent
          </button>
          <span className="grow"></span>
          <span className={'dc-count' + (ready ? ' ready' : '')}><b>{answeredCount}</b> of {openRows.length} answered</span>
        </div>
      </div>
    </div>
  )
}
