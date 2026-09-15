import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDb } from '../src/server/db/db'
import { createSession, createChatThread, getChatThread, listChatThreads, loadReviewState, upsertComment } from '../src/server/db/sessions'
import { registerIpc } from '../src/server/ipc'
import { resolveRefInput } from '../src/server/git'
import { lastFakeChatTurn, releaseFakeHolds } from '../src/server/engines/fake'
import { makeFixtureRepo } from './helpers/fixtureRepo'
import { ACTIONS_PREF_KEY, serializeActions } from '../src/shared/actions'
import type { ActionDef, AgentRef, Comment, RefPair } from '../src/shared/types'
import type { LoadedReview, OpEventMsg, OpResultMsg } from '../src/shared/ipc'
import type { Transport } from '../src/server/transport'
import type { CommandAvailability } from '../src/server/engines/probe'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

const agent: AgentRef = { engine: 'claude' }
const SIMPLIFY: ActionDef = { id: 'act-simplify', kind: 'skill', name: 'Simplify', body: 'simplify' }
const REBASE: ActionDef = { id: 'act-rebase', kind: 'prompt', name: 'Rebase onto main', body: 'Rebase this branch onto main [hold]' }
const CHURN: ActionDef = { id: 'act-churn', kind: 'prompt', name: 'Explain test churn', body: 'Explain the test churn [no-findings]' }
const AUDIT: ActionDef = { id: 'act-audit', kind: 'prompt', name: 'Audit', body: 'Audit the change', findings: true }
const QUIET: ActionDef = { id: 'act-quiet', kind: 'skill', name: 'Quiet', body: 'simplify', findings: false }
const BROKEN: ActionDef = { id: 'act-broken', kind: 'prompt', name: 'Broken', body: 'Audit [extract-fail]', findings: true }

interface Harness {
  db: ReturnType<typeof openDb>['db']
  handlers: Map<string, (...args: unknown[]) => Promise<unknown>>
  results: OpResultMsg[]
  events: OpEventMsg[]
  sessionId: number
  repo: string
}

async function setup(actions: ActionDef[] = [SIMPLIFY, REBASE, CHURN, AUDIT, QUIET, BROKEN]): Promise<Harness> {
  const { dir } = makeFixtureRepo()
  const base = await resolveRefInput(dir, 'main')
  const compare = await resolveRefInput(dir, 'feature')
  const pair: RefPair = {
    base: { kind: base.kind, symbol: base.symbol, anchorSha: base.sha },
    compare: { kind: compare.kind, symbol: compare.symbol, anchorSha: compare.sha }
  }
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'limn-act-')), 'db')).db
  db.prepare('INSERT INTO prefs (key, value) VALUES (?, ?)').run(ACTIONS_PREF_KEY, serializeActions(actions))
  const sessionId = createSession(db, dir, pair, agent).id
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()
  const results: OpResultMsg[] = []
  const events: OpEventMsg[] = []
  const transport: Transport = {
    handle(name, fn) { handlers.set(name, fn as (...a: unknown[]) => Promise<unknown>) },
    broadcast(channel, msg) {
      if (channel === 'op:result') results.push(msg as OpResultMsg)
      if (channel === 'op:event') events.push(msg as OpEventMsg)
    },
    notify() { /* unused */ },
    async pickDirectory() { return null }
  }
  registerIpc(db, [], transport)
  return { db, handlers, results, events, sessionId, repo: dir }
}

async function settled(h: Harness, opId: string, timeoutMs = 10000): Promise<OpResultMsg> {
  const start = Date.now()
  for (;;) {
    const r = h.results.find((x) => x.opId === opId)
    if (r) return r
    if (Date.now() - start > timeoutMs) throw new Error(`op ${opId} never settled`)
    await new Promise((res) => setTimeout(res, 10))
  }
}

async function waitForHold(h: Harness, opId: string): Promise<void> {
  const start = Date.now()
  while (!h.events.some((e) => e.opId === opId && e.event.type === 'status' && e.event.text.startsWith('holding'))) {
    if (Date.now() - start > 10000) throw new Error(`op ${opId} never reached its hold`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

beforeEach(() => { process.env.LIMN_DEMO = '1'; process.env.LIMN_FAKE_COMMANDS = 'simplify,security-review,compact' })
afterEach(() => { releaseFakeHolds(); delete process.env.LIMN_DEMO; delete process.env.LIMN_FAKE_COMMANDS })

const findingsOf = (h: Harness, runId: string): Comment[] => loadReviewState(h.db, h.sessionId).comments.filter((c) => c.source?.runId === runId)

describe('runAction — every launch is a fresh thread; Re-run is a turn in that thread', () => {
  it('a new-thread run creates the action thread, numbers the run, sends the engine spelling alone, and the findings pass mints its proposals', async () => {
    const h = await setup()
    const out = await h.handlers.get('runAction')!(h.sessionId, SIMPLIFY.id, { kind: 'new', agent }, 'op-1') as { threadId: number; runId: string }
    const thread = getChatThread(h.db, out.threadId)!
    expect(thread.action).toEqual({ actionId: SIMPLIFY.id, name: 'Simplify', kind: 'skill' })
    expect(thread.title).toBe('Simplify')
    expect(thread.executionMode).toBe('auto')
    expect(out.runId).toBe(`run-${out.threadId}-1`)
    // the launching user message is persisted at once (the run may wait in the queue)
    expect(thread.messages[0]).toMatchObject({ role: 'user', run: { actionId: SIMPLIFY.id, runId: out.runId, n: 1, name: 'Simplify', kind: 'skill', findings: true } })
    expect(typeof thread.messages[0].run!.headAtStart).toBe('string')
    expect(thread.messages[0].text).toBe('/simplify')

    const res = await settled(h, 'op-1')
    expect(res.status).toBe('succeeded')
    // the run's turn is the spelling alone, framed by the engine, write-capable
    expect(lastFakeChatTurn()!.message).toBe('/simplify')
    expect(lastFakeChatTurn()!.writeEnabled).toBe(true)
    expect(lastFakeChatTurn()!.raw).toBeFalsy()
    // the fake's findings pass reports two findings; Limn mints them under the run
    const findings = findingsOf(h, out.runId)
    expect(findings).toHaveLength(2)
    for (const f of findings) {
      expect(f.status).toBe('proposed')
      expect(f.source).toEqual({ actionId: SIMPLIFY.id, runId: out.runId, threadId: out.threadId })
      expect(f.severity).toBeDefined()
    }
    const after = getChatThread(h.db, out.threadId)!
    const last = after.messages.at(-1)!
    expect(last).toMatchObject({ role: 'agent', runResult: { runId: out.runId, outcome: 'finished', extraction: 'ok', delta: { commits: 0, files: 0, dirty: false } } })
    // the minted proposals streamed to the tab as finding_added actions
    expect(h.events.filter((e) => e.opId === 'op-1' && e.event.type === 'action' && e.event.action.kind === 'finding_added')).toHaveLength(2)
  })

  it('a prompt action that collects findings gets the pass; one that does not is skipped; a pass that cannot parse is recorded as failed', async () => {
    const h = await setup()
    const audit = await h.handlers.get('runAction')!(h.sessionId, AUDIT.id, { kind: 'new', agent }, 'op-a') as { threadId: number; runId: string }
    await settled(h, 'op-a')
    expect(findingsOf(h, audit.runId)).toHaveLength(2)
    expect(getChatThread(h.db, audit.threadId)!.messages.at(-1)!.runResult?.extraction).toBe('ok')

    const quiet = await h.handlers.get('runAction')!(h.sessionId, QUIET.id, { kind: 'new', agent }, 'op-q') as { threadId: number; runId: string }
    await settled(h, 'op-q')
    expect(findingsOf(h, quiet.runId)).toHaveLength(0)
    expect(getChatThread(h.db, quiet.threadId)!.messages[0].run?.findings).toBe(false)
    expect(getChatThread(h.db, quiet.threadId)!.messages.at(-1)!.runResult?.extraction).toBe('skipped')

    const broken = await h.handlers.get('runAction')!(h.sessionId, BROKEN.id, { kind: 'new', agent }, 'op-b') as { threadId: number; runId: string }
    expect((await settled(h, 'op-b')).status).toBe('succeeded')
    expect(findingsOf(h, broken.runId)).toHaveLength(0)
    expect(getChatThread(h.db, broken.threadId)!.messages.at(-1)!.runResult?.extraction).toBe('failed')
  })

  it('a second new-thread launch starts a fresh thread (fresh engine session) and still sweeps the first run\'s untouched proposals', async () => {
    const h = await setup()
    const first = await h.handlers.get('runAction')!(h.sessionId, SIMPLIFY.id, { kind: 'new', agent }, 'op-1') as { threadId: number; runId: string }
    await settled(h, 'op-1')
    const [keep, sweep] = findingsOf(h, first.runId)
    // the reviewer accepted one and replied to none of the others
    upsertComment(h.db, h.sessionId, { ...keep, status: 'queued' })
    const second = await h.handlers.get('runAction')!(h.sessionId, SIMPLIFY.id, { kind: 'new', agent }, 'op-2') as { threadId: number; runId: string }
    expect(second.threadId).not.toBe(first.threadId)
    expect(second.runId).toBe(`run-${second.threadId}-1`)
    // swept at launch, before the new run produces anything
    const ids = loadReviewState(h.db, h.sessionId).comments.map((c) => c.id)
    expect(ids).toContain(keep.id)
    expect(ids).not.toContain(sweep.id)
    await settled(h, 'op-2')
    expect(findingsOf(h, second.runId)).toHaveLength(2)
    const threads = listChatThreads(h.db, h.sessionId).filter((t) => t.action)
    expect(threads.map((t) => t.action?.actionId)).toEqual([SIMPLIFY.id, SIMPLIFY.id])
    expect(getChatThread(h.db, first.threadId)!.engineSessionId).not.toBe(getChatThread(h.db, second.threadId)!.engineSessionId)
  })

  it('Re-run targets the action thread itself: run 2 lands there, keeps the action, and sweeps run 1\'s untouched proposals', async () => {
    const h = await setup()
    const first = await h.handlers.get('runAction')!(h.sessionId, SIMPLIFY.id, { kind: 'new', agent }, 'op-1') as { threadId: number; runId: string }
    await settled(h, 'op-1')
    const [sweep] = findingsOf(h, first.runId)
    const second = await h.handlers.get('runAction')!(h.sessionId, SIMPLIFY.id, { kind: 'thread', threadId: first.threadId }, 'op-2') as { threadId: number; runId: string }
    expect(second.threadId).toBe(first.threadId)
    expect(second.runId).toBe(`run-${first.threadId}-2`)
    expect(loadReviewState(h.db, h.sessionId).comments.map((c) => c.id)).not.toContain(sweep.id)
    await settled(h, 'op-2')
    const t = getChatThread(h.db, first.threadId)!
    expect(t.action?.actionId).toBe(SIMPLIFY.id)
    expect(t.messages.filter((m) => m.run).map((m) => m.run!.n)).toEqual([1, 2])
    expect(listChatThreads(h.db, h.sessionId).filter((x) => x.action)).toHaveLength(1)
  })

  it('a prompt action sends its text verbatim; without the switch no findings pass runs', async () => {
    const h = await setup()
    const out = await h.handlers.get('runAction')!(h.sessionId, CHURN.id, { kind: 'new', agent }, 'op-c') as { threadId: number; runId: string }
    await settled(h, 'op-c')
    expect(lastFakeChatTurn()!.message).toBe(CHURN.body)
    expect(findingsOf(h, out.runId)).toHaveLength(0)
    expect(getChatThread(h.db, out.threadId)!.messages.at(-1)!.runResult).toMatchObject({ runId: out.runId, outcome: 'finished', extraction: 'skipped' })
  })

  it('runs inside an existing thread, keeping that thread\'s name and numbering runs there', async () => {
    const h = await setup()
    const existing = createChatThread(h.db, h.sessionId, { kind: 'user', agent, title: 'Security pass' }).id
    const out = await h.handlers.get('runAction')!(h.sessionId, SIMPLIFY.id, { kind: 'thread', threadId: existing }, 'op-e') as { threadId: number; runId: string }
    expect(out.threadId).toBe(existing)
    await settled(h, 'op-e')
    const t = getChatThread(h.db, existing)!
    expect(t.title).toBe('Security pass')
    expect(t.action).toBeUndefined()
    expect(t.messages[0].run?.n).toBe(1)
    expect(findingsOf(h, out.runId).map((f) => f.source?.threadId)).toEqual([existing, existing])
  })

  it('refuses a skill run before the prompt when the engine did not report the skill', async () => {
    process.env.LIMN_FAKE_COMMANDS = 'compact,review'
    const h = await setup()
    const out = await h.handlers.get('runAction')!(h.sessionId, SIMPLIFY.id, { kind: 'new', agent }, 'op-r') as { threadId: number; runId: string }
    const res = await settled(h, 'op-r')
    expect(res.status).toBe('failed')
    expect(res.errorCode).toBe('SKILL_UNAVAILABLE')
    expect(res.error).toContain('Simplify is not installed for Claude')
    const t = getChatThread(h.db, out.threadId)!
    expect(t.messages.at(-1)).toMatchObject({ role: 'agent', runResult: { runId: out.runId, outcome: 'refused' } })
    expect(t.messages.at(-1)!.runResult!.error).toContain('not installed')
    // the session's own report is recorded for the marks
    const avail = await h.handlers.get('commandAvailability')!(h.repo) as CommandAvailability[]
    expect(avail.find((a) => a.engine === 'claude')).toMatchObject({ names: ['compact', 'review'], state: 'ok' })
  })

  it('a resumed session that sends no list trusts the cache and stamps the run with the cache time', async () => {
    const h = await setup()
    // a prior probe said Claude has it, 2 minutes ago
    await h.handlers.get('probeCommands')!(h.repo, ['claude'])
    delete process.env.LIMN_FAKE_COMMANDS // the run's own session announces nothing
    const out = await h.handlers.get('runAction')!(h.sessionId, SIMPLIFY.id, { kind: 'new', agent }, 'op-t') as { threadId: number; runId: string }
    const res = await settled(h, 'op-t')
    expect(res.status).toBe('succeeded')
    const last = getChatThread(h.db, out.threadId)!.messages.at(-1)!
    expect(last.runResult?.outcome).toBe('finished')
    expect(typeof last.runResult?.availabilityFrom).toBe('string')
  })

  it('a cancelled first run that attached nothing removes its thread; a later cancelled run keeps it', async () => {
    const h = await setup()
    const out = await h.handlers.get('runAction')!(h.sessionId, REBASE.id, { kind: 'new', agent }, 'op-k') as { threadId: number; runId: string }
    // the fake parks on [hold]; cancel while nothing has landed
    process.env.LIMN_FAKE_COMMANDS = ''
    await h.handlers.get('cancel')!('op-k')
    const res = await settled(h, 'op-k')
    expect(res.status).toBe('cancelled')
    expect(res.reload).toBe(true)
    expect(getChatThread(h.db, out.threadId)).toBeNull()
  })

  it('a run that rebases the branch gets a "rewritten" receipt, not counts against a baseline that is no longer an ancestor', async () => {
    const h = await setup()
    const out = await h.handlers.get('runAction')!(h.sessionId, REBASE.id, { kind: 'new', agent }, 'op-rw') as { threadId: number; runId: string }
    const headAtStart = getChatThread(h.db, out.threadId)!.messages[0].run!.headAtStart!
    await waitForHold(h, 'op-rw')
    // while the fake is parked on [hold], rewrite the branch: a new base commit on
    // main, then feature rebased onto it. Same tree, every commit a new SHA.
    execFileSync('git', ['checkout', '-q', 'main'], { cwd: h.repo })
    fs.writeFileSync(path.join(h.repo, 'docs/notes.md'), 'notes\n')
    execFileSync('git', ['add', '-A'], { cwd: h.repo })
    execFileSync('git', ['commit', '-q', '-m', 'main moves'], { cwd: h.repo })
    execFileSync('git', ['checkout', '-q', 'feature'], { cwd: h.repo })
    execFileSync('git', ['rebase', '-q', 'main'], { cwd: h.repo })
    expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: h.repo }).toString().trim()).not.toBe(headAtStart)
    releaseFakeHolds()
    const res = await settled(h, 'op-rw')
    expect(res.status).toBe('succeeded')
    const last = getChatThread(h.db, out.threadId)!.messages.at(-1)!
    expect(last.runResult?.delta).toEqual({ commits: 0, files: 0, dirty: false, rewritten: true })
  })

  it('refuses a run and a chat message while the compare branch is not checked out anywhere', async () => {
    const h = await setup()
    // a branch that exists but no checkout holds: the turn would run on the wrong tree
    execFileSync('git', ['branch', 'other'], { cwd: h.repo })
    const base = await resolveRefInput(h.repo, 'main')
    const other = await resolveRefInput(h.repo, 'other')
    const detached = createSession(h.db, h.repo, {
      base: { kind: base.kind, symbol: base.symbol, anchorSha: base.sha },
      compare: { kind: other.kind, symbol: other.symbol, anchorSha: other.sha }
    }, agent).id
    await expect(h.handlers.get('runAction')!(detached, SIMPLIFY.id, { kind: 'new', agent }, 'op-nc')).rejects.toThrow(/Check out other to run actions/)
    const thread = createChatThread(h.db, detached, { kind: 'user', agent, title: 'Chat' })
    await h.handlers.get('sendChat')!(thread.id, 'why?', 'op-nc2')
    const res = await settled(h, 'op-nc2')
    expect(res.status).toBe('failed')
    expect(res.error).toContain('Check out other to chat or run actions')
  })

  it('unknown action or foreign thread is rejected', async () => {
    const h = await setup()
    await expect(h.handlers.get('runAction')!(h.sessionId, 'nope', { kind: 'new', agent }, 'op-x')).rejects.toThrow(/unknown action/i)
    await expect(h.handlers.get('runAction')!(h.sessionId, SIMPLIFY.id, { kind: 'thread', threadId: 999 }, 'op-y')).rejects.toThrow(/thread/i)
  })
})

describe('attachFindings / setRunFlag', () => {
  it('attachFindings sends one more turn in the same thread under the same run', async () => {
    const h = await setup()
    const out = await h.handlers.get('runAction')!(h.sessionId, CHURN.id, { kind: 'new', agent }, 'op-1') as { threadId: number; runId: string }
    await settled(h, 'op-1')
    expect(findingsOf(h, out.runId)).toHaveLength(0)
    await h.handlers.get('attachFindings')!(out.threadId, out.runId, 'op-2')
    expect((await settled(h, 'op-2')).status).toBe('succeeded')
    expect(lastFakeChatTurn()!.message).toContain('add_finding')
    expect(findingsOf(h, out.runId)).toHaveLength(2)
    const msgs = getChatThread(h.db, out.threadId)!.messages
    expect(msgs.map((m) => m.role)).toEqual(['user', 'agent', 'user', 'agent'])
    expect(msgs[2].run).toEqual(msgs[0].run) // same run, not run 2
    // the attach turn collects through the tool, never through a second pass
    expect(msgs[3].runResult).toMatchObject({ runId: out.runId, outcome: 'finished', extraction: 'skipped' })
  })

  it('an action run exposes read-only context only; the attach turn adds add_finding; chat keeps the catalog', async () => {
    const h = await setup()
    const out = await h.handlers.get('runAction')!(h.sessionId, CHURN.id, { kind: 'new', agent }, 'op-1') as { threadId: number; runId: string }
    await settled(h, 'op-1')
    expect(lastFakeChatTurn()!.tools!.tools.map((t) => t.name).sort()).toEqual(['get_review', 'get_review_progress', 'list_comments'])
    await h.handlers.get('attachFindings')!(out.threadId, out.runId, 'op-2')
    await settled(h, 'op-2')
    expect(lastFakeChatTurn()!.tools!.tools.map((t) => t.name).sort()).toEqual(['add_finding', 'get_review', 'get_review_progress', 'list_comments'])
    await h.handlers.get('sendChat')!(out.threadId, 'plain question', 'op-3')
    await settled(h, 'op-3')
    expect(lastFakeChatTurn()!.tools!.tools).toHaveLength(11)
  })

  it('setRunFlag keepProse marks the run result', async () => {
    const h = await setup()
    const out = await h.handlers.get('runAction')!(h.sessionId, CHURN.id, { kind: 'new', agent }, 'op-1') as { threadId: number; runId: string }
    await settled(h, 'op-1')
    const threads = await h.handlers.get('setRunFlag')!(out.threadId, out.runId, 'keepProse') as { id: number; messages: { runResult?: { keepProse?: boolean } }[] }[]
    expect(threads.find((t) => t.id === out.threadId)!.messages.at(-1)!.runResult?.keepProse).toBe(true)
  })
})

describe('triageFindings', () => {
  const seed = (h: Harness, id: string, status: Comment['status'] = 'proposed'): void => {
    upsertComment(h.db, h.sessionId, {
      id, anchor: { kind: 'diff', file: 'src/a.ts', side: 'new', line: 2, hunkRange: '', lineContent: '' },
      author: 'agent', text: 'finding', severity: 'note', status, source: { actionId: 'a', runId: 'r' },
      replies: [], createdAt: 'now', iteration: 1
    })
  }
  it('accept → queued, keep → resolved, dismiss → dismissed, restore → proposed; severity survives', async () => {
    const h = await setup()
    for (const id of ['p1', 'p2', 'p3', 'p4']) seed(h, id)
    const st = (ids: string[], verdict: string) => h.handlers.get('triageFindings')!(h.sessionId, ids, verdict) as Promise<{ comments: Comment[] }>
    let s = await st(['p1'], 'accept')
    expect(s.comments.find((c) => c.id === 'p1')).toMatchObject({ status: 'queued', severity: 'note' })
    s = await st(['p2'], 'keep')
    expect(s.comments.find((c) => c.id === 'p2')).toMatchObject({ status: 'resolved', severity: 'note' })
    s = await st(['p3', 'p4'], 'dismiss')
    expect(s.comments.filter((c) => c.status === 'dismissed').map((c) => c.id).sort()).toEqual(['p3', 'p4'])
    s = await st(['p3'], 'restore')
    expect(s.comments.find((c) => c.id === 'p3')!.status).toBe('proposed')
    // a non-proposal is left alone
    s = await st(['p1'], 'dismiss')
    expect(s.comments.find((c) => c.id === 'p1')!.status).toBe('queued')
  })
})

describe('command availability RPCs', () => {
  it('commandAvailability reports unknown before any probe; probeCommands fills it; seenCommands unions skills', async () => {
    const h = await setup()
    const before = await h.handlers.get('commandAvailability')!(h.repo) as CommandAvailability[]
    expect(before.map((a) => a.state)).toEqual(['unknown', 'unknown'])
    const fresh = await h.handlers.get('probeCommands')!(h.repo) as CommandAvailability[]
    expect(fresh.find((a) => a.engine === 'claude')).toMatchObject({ names: ['simplify', 'security-review', 'compact'], state: 'ok' })
    expect(fresh.find((a) => a.engine === 'codex')).toMatchObject({ names: ['$simplify', '$security-review', '$compact'], state: 'ok' })
    const seen = await h.handlers.get('seenCommands')!() as { engine: string; names: string[] }[]
    expect(seen).toEqual([{ engine: 'claude', names: ['compact', 'security-review', 'simplify'] }, { engine: 'codex', names: ['compact', 'security-review', 'simplify'] }])
  })

  it('loadSession kicks a background probe only when a skill action is pinned', async () => {
    const h = await setup([REBASE])
    await h.handlers.get('loadSession')!(h.sessionId) as LoadedReview
    expect((await h.handlers.get('commandAvailability')!(h.repo) as CommandAvailability[]).map((a) => a.state)).toEqual(['unknown', 'unknown'])
    const h2 = await setup([SIMPLIFY])
    await h2.handlers.get('loadSession')!(h2.sessionId) as LoadedReview
    await new Promise((r) => setTimeout(r, 50))
    expect((await h2.handlers.get('commandAvailability')!(h2.repo) as CommandAvailability[]).map((a) => a.state)).toEqual(['ok', 'ok'])
  })
})
