import { describe, expect, it } from 'vitest'
import type { ActionRunRef, ChatMessage, Comment } from '../src/shared/types'
import type { OpState } from '../src/renderer/store'
import { deltaLabel, fmtDuration, latestRun, resultCardState, runBarState, runsOf } from '../src/renderer/lib/runs'

const run = (n: number, kind: ActionRunRef['kind'] = 'skill', actionId = 'act'): ActionRunRef => ({ actionId, runId: `run-1-${n}`, n, name: kind === 'skill' ? 'Simplify' : 'Rebase', kind })
const user = (r: ActionRunRef, at = '2026-09-08T10:00:00Z', text = '/simplify\n\nLimn: …'): ChatMessage => ({ role: 'user', text, at, run: r })
const agent = (runId: string, outcome: 'finished' | 'refused' | 'failed' | 'cancelled', at = '2026-09-08T10:01:12Z', extra: Record<string, unknown> = {}): ChatMessage =>
  ({ role: 'agent', text: 'Four simplifications.', at, runResult: { runId, outcome, ...extra } })
const idle: OpState = { running: false, opId: null, kind: null, threadId: null, log: [], error: null, startedAt: null, outcome: null, errorCode: null, answeredApprovals: new Set(), exclusive: false, queued: null }
const running: OpState = { ...idle, running: true, opId: 'op', kind: 'chat', threadId: 1, exclusive: true }
const finding = (id: string, runId: string, status: Comment['status'] = 'proposed', replies = 0): Comment =>
  ({ id, anchor: { kind: 'diff', file: 'a.ts', side: 'new', line: 2, hunkRange: '', lineContent: '' }, author: 'agent', text: 'f', severity: 'note', status, source: { actionId: 'act', runId }, replies: Array.from({ length: replies }, () => ({ author: 'user' as const, text: 'r', at: 't' })), createdAt: 't', iteration: 1 })

describe('runsOf', () => {
  it('pairs launching and ending messages, folds the attach-findings follow-up into its run, and marks superseded runs', () => {
    const messages: ChatMessage[] = [
      user(run(1)), agent('run-1-1', 'finished'),
      user(run(1), '2026-09-08T10:05:00Z', 'Attach each finding…'), agent('run-1-1', 'finished', '2026-09-08T10:05:30Z'),
      user(run(2), '2026-09-08T11:00:00Z')
    ]
    const runs = runsOf({ messages })
    expect(runs.map((r) => [r.run.n, r.launchIndex, r.result?.outcome ?? null, r.superseded])).toEqual([[1, 0, 'finished', true], [2, 4, null, false]])
    expect(runs[0].endedAt).toBe('2026-09-08T10:05:30Z')
    expect(latestRun({ messages })!.run.n).toBe(2)
    expect(latestRun({ messages: [] })).toBeNull()
  })
})

describe('runBarState', () => {
  const thread = { messages: [user(run(1)), agent('run-1-1', 'finished')] }
  it('follows the live op first: queued, then running with the skill as invoked', () => {
    expect(runBarState({ messages: [user(run(1))] }, { ...running, queued: { position: 2, behind: 'Generating the review' } }, [])).toEqual({ kind: 'queued', position: 2, behind: 'Generating the review' })
    expect(runBarState({ messages: [user(run(1))] }, running, [])).toEqual({ kind: 'running', spelled: '/simplify', collects: true })
    expect(runBarState({ messages: [user({ ...run(1, 'prompt'), findings: false }, 't', 'Rebase this…')] }, running, [])).toEqual({ kind: 'running', spelled: 'Rebase', collects: false })
  })
  it('then the persisted result: finished with count + duration, refused, failed, cancelled', () => {
    expect(runBarState(thread, idle, [finding('a', 'run-1-1'), finding('b', 'run-1-1', 'queued'), finding('c', 'other')])).toEqual({ kind: 'finished', collects: true, count: 2, delta: null, duration: '1 m 12 s' })
    const delta = { commits: 2, files: 11, dirty: false }
    expect(runBarState({ messages: [user(run(1)), agent('run-1-1', 'finished', 't', { delta })] }, idle, [])).toMatchObject({ kind: 'finished', delta })
    expect(runBarState({ messages: [user(run(1)), agent('run-1-1', 'finished', '2026-09-08T10:01:12Z', { availabilityFrom: 't0' })] }, idle, [])).toMatchObject({ kind: 'finished', availabilityFrom: 't0' })
    expect(runBarState({ messages: [user(run(1)), agent('run-1-1', 'refused', 't', { error: 'Simplify is not installed for Codex' })] }, idle, [])).toEqual({ kind: 'refused', error: 'Simplify is not installed for Codex' })
    expect(runBarState({ messages: [user(run(1)), agent('run-1-1', 'failed', 't', { error: 'boom' })] }, idle, [])).toEqual({ kind: 'failed', error: 'boom' })
    expect(runBarState({ messages: [user(run(1)), agent('run-1-1', 'cancelled')] }, idle, [])).toEqual({ kind: 'cancelled' })
    expect(runBarState({ messages: [{ role: 'user', text: 'plain', at: 't' }] }, idle, [])).toBeNull()
  })
  it('a run with no record and no live op reads as finished with what landed', () => {
    expect(runBarState({ messages: [user(run(1))] }, idle, [finding('a', 'run-1-1')])).toEqual({ kind: 'finished', collects: true, count: 1, delta: null, duration: '' })
  })
  it('deltaLabel spells the branch half of the receipt', () => {
    expect(deltaLabel(null)).toBeNull()
    expect(deltaLabel({ commits: 0, files: 0, dirty: false })).toBe('branch unchanged')
    expect(deltaLabel({ commits: 1, files: 3, dirty: false })).toBe('1 commit · 3 files')
    expect(deltaLabel({ commits: 0, files: 2, dirty: true })).toBe('2 files · uncommitted changes')
  })
  it('fmtDuration', () => {
    expect(fmtDuration(42_000)).toBe('42 s')
    expect(fmtDuration(72_000)).toBe('1 m 12 s')
    expect(fmtDuration(605_000)).toBe('10 m 05 s')
  })
})

describe('resultCardState', () => {
  const v = runsOf({ messages: [user(run(1)), agent('run-1-1', 'finished')] })[0]
  it('the receipt counts the run\'s proposals, open and dismissed, names the first open one, and carries the delta', () => {
    const cs = [finding('a', 'run-1-1'), finding('b', 'run-1-1', 'dismissed'), finding('c', 'run-1-1', 'queued')]
    expect(resultCardState(v, cs, 'report')).toEqual({ kind: 'receipt', runId: 'run-1-1', collects: true, open: 1, dismissed: 1, total: 3, first: cs[0], delta: null, attachOffer: false })
    const delta = { commits: 0, files: 0, dirty: false }
    const withDelta = runsOf({ messages: [user(run(1)), agent('run-1-1', 'finished', 't', { delta, extraction: 'ok' })] })[0]
    expect(resultCardState(withDelta, [], 'report')).toMatchObject({ kind: 'receipt', collects: true, total: 0, delta, attachOffer: false })
  })
  it('offers Attach findings only when the findings pass missed a report the run collected, unless kept as prose', () => {
    // a run recorded before the pass existed (no extraction field) still offers it
    expect(resultCardState(v, [], 'Review report…')).toMatchObject({ kind: 'receipt', attachOffer: true })
    expect(resultCardState(v, [], '   ')).toMatchObject({ attachOffer: false })
    const failed = runsOf({ messages: [user(run(1)), agent('run-1-1', 'finished', 't', { extraction: 'failed' })] })[0]
    expect(resultCardState(failed, [], 'Review report…')).toMatchObject({ attachOffer: true })
    const kept = runsOf({ messages: [user(run(1)), agent('run-1-1', 'finished', 't', { extraction: 'failed', keepProse: true })] })[0]
    expect(resultCardState(kept, [], 'Review report…')).toMatchObject({ attachOffer: false })
    // a run that does not collect findings gets a receipt without a findings half
    const prompt = runsOf({ messages: [user({ ...run(1, 'prompt'), findings: false }), agent('run-1-1', 'finished', 't', { extraction: 'skipped' })] })[0]
    expect(resultCardState(prompt, [], 'Explained the churn.')).toMatchObject({ kind: 'receipt', collects: false, total: 0, attachOffer: false })
  })
  it('a superseded run says so and counts what the reviewer kept', () => {
    const runs = runsOf({ messages: [user(run(1)), agent('run-1-1', 'finished'), user(run(2)), agent('run-1-2', 'finished')] })
    const cs = [finding('a', 'run-1-1', 'queued'), finding('b', 'run-1-1', 'proposed', 1), finding('c', 'run-1-2')]
    expect(resultCardState(runs[0], cs, 'x')).toEqual({ kind: 'superseded', by: 2, kept: 2 })
    expect(resultCardState(runs[1], cs, 'x')).toMatchObject({ kind: 'receipt', total: 1 })
  })
  it('nothing for a run that is not finished', () => {
    const going = runsOf({ messages: [user(run(1))] })[0]
    expect(resultCardState(going, [], '')).toBeNull()
    const refused = runsOf({ messages: [user(run(1)), agent('run-1-1', 'refused')] })[0]
    expect(resultCardState(refused, [], '')).toBeNull()
  })
})
