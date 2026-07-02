import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/main/db/db'
import * as dao from '../src/main/db/sessions'
import { createSession, loadReviewState, latestIteration, addIteration, upsertComment, replaceUiState } from '../src/main/db/sessions'
import { registerIpc } from '../src/main/ipc'
import { resolveRefInput } from '../src/main/git'
import { makeFixtureRepo, fixtureGit, fixtureWrite } from './helpers/fixtureRepo'
import type { AgentRef, Comment, RefPair } from '../src/shared/types'
import type { OpEventMsg, OpResultMsg } from '../src/shared/ipc'
import type { Transport } from '../src/main/transport'

const agent: AgentRef = { engine: 'codex', model: 'gpt-5.5', reasoningEffort: 'low' }

interface Harness {
  db: ReturnType<typeof openDb>['db']
  handlers: Map<string, (...args: unknown[]) => Promise<unknown>>
  events: OpEventMsg[]
  results: OpResultMsg[]
  sessionId: number
  repo: string
  notifications: { title: string; body: string }[]
}

async function setup(): Promise<Harness> {
  const { dir } = makeFixtureRepo()
  const base = await resolveRefInput(dir, 'main')
  const compare = await resolveRefInput(dir, 'feature')
  const pair: RefPair = {
    base: { kind: base.kind, symbol: base.symbol, anchorSha: base.sha },
    compare: { kind: compare.kind, symbol: compare.symbol, anchorSha: compare.sha }
  }
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'limn-scoped-')), 'db')).db
  const sessionId = createSession(db, dir, pair, agent).id
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()
  const events: OpEventMsg[] = []
  const results: OpResultMsg[] = []
  const notifications: { title: string; body: string }[] = []
  const transport: Transport = {
    handle(name, fn) { handlers.set(name, fn as (...a: unknown[]) => Promise<unknown>) },
    broadcast(channel, msg) {
      if (channel === 'op:event') events.push(msg as OpEventMsg)
      if (channel === 'op:result') results.push(msg as OpResultMsg)
    },
    notify(title, body) { notifications.push({ title, body }) },
    async pickDirectory() { return null }
  }
  registerIpc(db, [], transport)
  return { db, handlers, events, results, sessionId, repo: dir, notifications }
}

/** Run one generation (fresh or update) through beginReview + generate. */
async function generate(h: Harness, opId: string, update: boolean, steer?: string): Promise<void> {
  const threadId = await h.handlers.get('beginReview')!(h.sessionId, agent, update, steer) as number
  await h.handlers.get('generate')!(h.sessionId, agent, opId, threadId, steer, update)
}

/** All status-note texts emitted for an op (the live scoped/fallback log). */
function notes(h: Harness, opId: string): string[] {
  return h.events
    .filter((e) => e.opId === opId && e.event.type === 'status')
    .map((e) => (e.event as { type: 'status'; text: string }).text)
}

function sectionIds(h: Harness): string[] {
  return (loadReviewState(h.db, h.sessionId).annotations?.sections ?? []).map((s) => s.id)
}

beforeEach(() => { process.env.LIMN_DEMO = '1' })
afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.LIMN_DEMO
  delete process.env.LIMN_SCOPED_RESUME_FAIL
})

describe('generate — scoped update path (IPC integration)', () => {
  it('small drift takes the SCOPED path: scope=scoped, ids stable, reviewedAtSha advances', async () => {
    const h = await setup()
    await generate(h, 'op-full', false)
    const it1 = latestIteration(h.db, h.sessionId)!
    const idsBefore = sectionIds(h)
    expect(it1.scope).toBe('full')

    // a reviewed-section mark + a section-anchored comment on the untouched sections —
    // they must still resolve after the scoped update (their ids survive by construction).
    const keptSectionId = idsBefore[idsBefore.length - 1] // the '(root)' section, untouched by an src drift
    replaceUiState(h.db, h.sessionId, { reviewedSections: [keptSectionId] })
    const comment: Comment = {
      id: 'c1', text: 'still relevant?', status: 'queued', author: 'user',
      anchor: { kind: 'section', sectionId: keptSectionId }, createdAt: new Date().toISOString(),
      replies: [], iteration: 1
    }
    upsertComment(h.db, h.sessionId, comment)

    // small committed drift: edit one existing src file
    fixtureWrite(h.repo, 'src/a.ts', 'export function a() {\n  return 3\n}\nexport const K = 10\nexport const J = 20\n')
    fixtureGit(h.repo, 'add', '-A')
    fixtureGit(h.repo, 'commit', '-m', 'small drift')
    const newHead = fixtureGit(h.repo, 'rev-parse', 'HEAD')

    await generate(h, 'op-scoped', true)

    const it2 = latestIteration(h.db, h.sessionId)!
    expect(it2.n).toBe(2)
    expect(it2.scope).toBe('scoped')
    expect(it2.endSha).toBe(newHead)
    // untouched section ids identical across iterations
    expect(sectionIds(h)).toEqual(idsBefore)
    // the reviewed-section mark + section comment still resolve to live section ids
    const st = loadReviewState(h.db, h.sessionId)
    expect(st.reviewedSections).toEqual([keptSectionId])
    expect(st.annotations!.sections.some((s) => s.id === keptSectionId)).toBe(true)
    expect(st.reviewedAtSha).toBe(newHead)
    // the live status log carried the scoped note
    expect(notes(h, 'op-scoped').some((n) => /scoped update — 1 file changed since/.test(n))).toBe(true)
    // the persisted review-thread agent turn reports the section rollup
    const reviewThread = st.chats.find((t) => t.kind === 'review')!
    const turnText = reviewThread.messages.at(-1)!.text
    expect(turnText).toMatch(/^Updated \d+ of \d+ sections \(\+\d+ new, −\d+\)\.$/)
    // §8/Q10: the completion notification for a scoped run mirrors that persisted turn
    // (the FULL first-generation notification is the plain "N sections — …" summary).
    expect(h.notifications.at(-1)).toEqual({ title: 'Guided review ready', body: turnText })
    expect(h.notifications[0].body).toMatch(/ sections — /) // the initial full run
  })

  it('large drift falls to the FULL path (scope=full)', async () => {
    const h = await setup()
    await generate(h, 'op-full', false)

    // 9 new files > SCOPE_MAX_FILES (8) → not scopedEligible → full
    for (let i = 0; i < 9; i++) fixtureWrite(h.repo, `big/f${i}.ts`, `export const f${i} = ${i}\n`)
    fixtureGit(h.repo, 'add', '-A')
    fixtureGit(h.repo, 'commit', '-m', 'large drift')

    await generate(h, 'op-large', true)
    const it2 = latestIteration(h.db, h.sessionId)!
    expect(it2.n).toBe(2)
    expect(it2.scope).toBe('full')
  })

  it('bad scoped output (SpliceError) → exactly ONE full fallback, single iteration row, status note', async () => {
    const h = await setup()
    await generate(h, 'op-full', false)

    fixtureWrite(h.repo, 'src/a.ts', 'export function a() {\n  return 4\n}\n')
    fixtureGit(h.repo, 'add', '-A')
    fixtureGit(h.repo, 'commit', '-m', 'drift for dup')

    // [scoped-dup] makes the fake emit a duplicate-id patch → splice refuses → step 3
    await generate(h, 'op-dup', true, '[scoped-dup]')

    const st = loadReviewState(h.db, h.sessionId)
    expect(st.iterations.map((i) => i.n)).toEqual([1, 2]) // ONE new iteration, not two
    expect(st.latestIteration!.scope).toBe('full')        // the fallback wrote a full iteration
    expect(notes(h, 'op-dup').some((n) => /scoped update failed .* running a full update/.test(n))).toBe(true)
    const res = h.results.find((r) => r.opId === 'op-dup')!
    expect(res.status).toBe('succeeded')
  })

  it('chain cap: after 5 consecutive scoped iterations the 6th is forced FULL', async () => {
    const h = await setup()
    await generate(h, 'op-full', false)
    const it1 = latestIteration(h.db, h.sessionId)!

    // simulate 5 consecutive scoped iterations (n=2..6) at the same endSha
    for (let n = 2; n <= 6; n++) {
      addIteration(h.db, h.sessionId, {
        n, engine: agent.engine, sessionId: `es-${n}`, endSha: it1.endSha,
        at: new Date().toISOString(), title: it1.annotations.title, summary: it1.annotations.summary,
        annotations: it1.annotations, scope: 'scoped'
      })
    }

    // small drift that would otherwise be scoped-eligible
    fixtureWrite(h.repo, 'src/a.ts', 'export function a() {\n  return 5\n}\n')
    fixtureGit(h.repo, 'add', '-A')
    fixtureGit(h.repo, 'commit', '-m', 'drift after chain')

    await generate(h, 'op-capped', true)
    const it7 = latestIteration(h.db, h.sessionId)!
    expect(it7.n).toBe(7)
    expect(it7.scope).toBe('full') // chain cap re-grounded to a full pass
  })

  it('resume failure → ONE fresh-scoped retry (still scoped, not a full fallback)', async () => {
    const h = await setup()
    await generate(h, 'op-full', false)

    fixtureWrite(h.repo, 'src/a.ts', 'export function a() {\n  return 6\n}\n')
    fixtureGit(h.repo, 'add', '-A')
    fixtureGit(h.repo, 'commit', '-m', 'drift for resume-fail')

    // [scoped-resume-fail] throws at run-start ONLY when resuming; the fresh retry succeeds
    await generate(h, 'op-resume', true, '[scoped-resume-fail]')

    const st = loadReviewState(h.db, h.sessionId)
    expect(st.iterations.map((i) => i.n)).toEqual([1, 2])
    expect(st.latestIteration!.scope).toBe('scoped') // resumed→fresh, still the scoped path
    const ns = notes(h, 'op-resume')
    expect(ns.some((n) => /could not resume prior session — retrying scoped update fresh/.test(n))).toBe(true)
    expect(ns.some((n) => /running a full update/.test(n))).toBe(false) // NOT a full fallback
  })

  it('cancel during scoped setup → no engine launch, no iteration, op cancelled', async () => {
    const h = await setup()
    await generate(h, 'op-full', false)

    fixtureWrite(h.repo, 'src/a.ts', 'export function a() {\n  return 7\n}\n')
    fixtureGit(h.repo, 'add', '-A')
    fixtureGit(h.repo, 'commit', '-m', 'drift for cancel')

    await h.handlers.get('cancel')!('op-cancel')
    await generate(h, 'op-cancel', true)

    const res = h.results.find((r) => r.opId === 'op-cancel')!
    expect(res.status).toBe('cancelled')
    expect(loadReviewState(h.db, h.sessionId).iterations.map((i) => i.n)).toEqual([1]) // no new iteration
    // engine never launched: no scoped status note streamed for this op
    expect(notes(h, 'op-cancel').some((n) => /scoped update/.test(n))).toBe(false)
  })

  it('an eligibility probe that throws degrades to the FULL path (never a hard op failure)', async () => {
    const h = await setup()
    await generate(h, 'op-full', false)

    // small committed drift so the prior endSha is reachable (isAncestor passes) and we
    // reach the chain-cap probe — which we force to throw, simulating any new git/DB
    // eligibility probe failing. Pre-branch, this update would have just run a full gen.
    fixtureWrite(h.repo, 'src/a.ts', 'export function a() {\n  return 8\n}\n')
    fixtureGit(h.repo, 'add', '-A')
    fixtureGit(h.repo, 'commit', '-m', 'drift for probe error')

    // ipc.ts calls `dao.trailingScopedCount(...)` through this same namespace object.
    const spy = vi.spyOn(dao, 'trailingScopedCount').mockImplementation(() => { throw new Error('probe boom') })
    await generate(h, 'op-probe', true)
    expect(spy).toHaveBeenCalled()

    const st = loadReviewState(h.db, h.sessionId)
    expect(st.iterations.map((i) => i.n)).toEqual([1, 2]) // ONE new iteration, op succeeded
    expect(st.latestIteration!.scope).toBe('full')        // degraded to the full path
    const res = h.results.find((r) => r.opId === 'op-probe')!
    expect(res.status).toBe('succeeded')                   // no error thread / hard failure
    expect(notes(h, 'op-probe').some((n) => /could not assess drift .* running a full update/.test(n))).toBe(true)
    // no scoped attempt was made
    expect(notes(h, 'op-probe').some((n) => /scoped update —/.test(n))).toBe(false)
  })

  it('missed new file (sinceAddedPaths) → warning surfaced, scoped kept (no fallback)', async () => {
    const h = await setup()
    await generate(h, 'op-full', false)

    // a genuinely new file in a new dir; [scoped-miss] makes the fake NOT claim it
    fixtureWrite(h.repo, 'newmod/x.ts', 'export const x = 1\n')
    fixtureGit(h.repo, 'add', '-A')
    fixtureGit(h.repo, 'commit', '-m', 'drift adds new file')

    await generate(h, 'op-miss', true, '[scoped-miss]')

    const st = loadReviewState(h.db, h.sessionId)
    expect(st.latestIteration!.scope).toBe('scoped') // Q5: warn, do NOT fall back
    expect(st.iterations.map((i) => i.n)).toEqual([1, 2])
    const ns = notes(h, 'op-miss')
    expect(ns.some((n) => n.includes('newmod/x.ts') && /Other changes/.test(n))).toBe(true)
    expect(ns.some((n) => /running a full update/.test(n))).toBe(false)
  })
})
