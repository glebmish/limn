import { useEffect, useMemo, useState } from 'react'
import type { AgentAction, AgentQuestion, ChatThread, Comment, EngineEvent } from '../../shared/types'
import type { LoadedReview } from '../../shared/ipc'
import { agentLabel } from '../../shared/agents'
import type { OpState } from '../store'
import { anyRunning, opForThread, useStore } from '../store'
import { I, EngineGlyph } from '../kit'
import { currentReviewChat, sendAnswers } from '../lib/comments'

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

function progressStep(log: EngineEvent[]): number {
  const sawReviewEdit = log.some((event) => event.type === 'action' && event.action.kind === 'review_edited')
  const sawText = log.some((event) => event.type === 'text')
  const sawTool = log.some((event) => event.type === 'tool')
  if (sawReviewEdit || sawText) return 2
  if (sawTool) return 1
  return 0
}

/** The review thread this card belongs to — the SAME pick `sendAnswers` makes
 *  (lib/comments.ts): the thread that authored the latest iteration, else the newest
 *  review thread. The one-argument pick used to be re-derived here, which parts
 *  company with the send after an aborted regenerate — the newest review thread is
 *  then an empty one that never got an engine session, while the questions on screen
 *  came from the older thread the answers are streamed into. `sent`, the thread a
 *  batch actually went to this session, wins outright. */
export function decisionThreadId(loaded: LoadedReview | null, sent: number | null = null): number | undefined {
  return sent ?? currentReviewChat(loaded?.state.chats ?? [], loaded?.state.latestIteration?.sessionId)?.id
}

export interface DecisionTurn {
  /** whether the answer turn (or anything else) is streaming into the review thread */
  running: boolean
  /** that op's event log — what the progress card steps through */
  log: EngineEvent[]
  runningThisTurn: boolean
  ready: boolean
}

/** The decision card's in-flight state.
 *
 *  The op it watches is the one on the REVIEW THREAD, whatever its kind: answering
 *  goes `sendAnswers` → `sendBatch`, which registers a **chat** op (store/chat.ts),
 *  so watching only `review`-kind ops left the progress card unreachable and the
 *  submit button live for the whole turn. `ready` additionally clears while ANY op
 *  runs, because `sendBatch` needs the exclusive lane and early-returns otherwise —
 *  a clickable button there is a silent no-op. */
export function decisionTurn(input: {
  ops: Record<string, OpState>
  loaded: LoadedReview | null
  adding: boolean
  activeCount: number
  openCount: number
  answeredCount: number
}): DecisionTurn {
  const threadId = decisionThreadId(input.loaded)
  const gen = opForThread(input.ops, threadId)
  return {
    running: gen.running,
    log: gen.log,
    runningThisTurn: (input.adding || gen.running) && input.activeCount > 0,
    ready: input.openCount > 0 && input.answeredCount === input.openCount
      && !input.adding && !anyRunning(input.ops) && threadId != null
  }
}

/** "Agent needs decisions" block — open intent questions from the review, answered as one refine turn. */
export function Questions() {
  const loaded = useStore((s) => s.loaded)
  const ops = useStore((s) => s.ops)
  const openChat = useStore((s) => s.openChat)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [adding, setAdding] = useState(false)
  const [activeCommentIds, setActiveCommentIds] = useState<string[]>([])
  /** the thread this card's answers were actually sent to, once they have been */
  const [sentThreadId, setSentThreadId] = useState<number | null>(null)

  const questions = loaded?.state.annotations?.questions ?? EMPTY_QUESTIONS
  const comments = loaded?.state.comments ?? EMPTY_COMMENTS
  const threadId = decisionThreadId(loaded)
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
  const answeredCount = openRows.filter((row) => answers[row.question.id]?.trim()).length
  const turn = decisionTurn({ ops, loaded, adding, activeCount: activeCommentIds.length, openCount: openRows.length, answeredCount })
  const runningThisTurn = turn.runningThisTurn
  const step = progressStep(turn.log)
  const progress = step === 0 ? '22%' : step === 1 ? '64%' : '100%'
  const ready = turn.ready
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
    if (!turn.running && !adding && activeCommentIds.length > 0) setActiveCommentIds([])
  }, [activeCommentIds.length, adding, turn.running])

  if (questions.length === 0) return null

  const submit = (): void => {
    if (!ready || !loaded || threadId == null) return
    setAdding(true)
    void (async () => {
      // finally: a throw anywhere below must not leave the form stuck on "adding"
      try {
        const ids: string[] = []
        for (const row of openRows) {
          const text = answers[row.question.id]?.trim()
          if (!text) continue
          if (row.queued) {
            // a failed edit is in the error strip; sending the stale text instead would
            // answer with something the reviewer already rewrote
            if (row.queued.text !== text && !(await useStore.getState().editComment(row.queued, text))) continue
            ids.push(row.queued.id)
          } else {
            const id = await useStore.getState().addComment({ kind: 'question', questionId: row.question.id }, text)
            if (id) ids.push(id)
          }
        }
        if (ids.length > 0) {
          setActiveCommentIds(ids)
          setSentThreadId(sendAnswers(ids) ?? null)
        }
      } catch (err) {
        useStore.setState({ error: err instanceof Error ? err.message : String(err) })
      } finally {
        setAdding(false)
      }
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
            <button className="dc-chat" onClick={() => openChat(decisionThreadId(loaded, sentThreadId))}>
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
