import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDb } from '../src/server/db/db'
import { CLAUDE_ACP_CONFIG, CODEX_ACP_CONFIG, type AcpEngineConfig } from '../src/server/engines/adapters'
import { CommandCache, CommandProber, hasSkill, probeCommands, skillNames } from '../src/server/engines/probe'
import type { FakeScript } from './helpers/fakeAcpAgent'

const FAKE_ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'helpers', 'fakeAcpAgent.ts')
const tmp: string[] = []
afterEach(() => { for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

function fakeConfig(script: FakeScript, base: AcpEngineConfig = CLAUDE_ACP_CONFIG, entry = FAKE_ENTRY): AcpEngineConfig {
  return { ...base, adapterEntry: entry, binaryRequired: false, binaryEnv: () => ({}), env: () => ({ LIMN_FAKE_ACP_SCRIPT: JSON.stringify(script) }) }
}

describe('skill names per engine', () => {
  it('Claude reports skills bare; Codex marks skills with $ and lists built-ins bare', () => {
    expect(skillNames('claude', ['simplify', 'pr-review-toolkit:review-pr', 'compact'])).toEqual(['simplify', 'pr-review-toolkit:review-pr', 'compact'])
    expect(skillNames('codex', ['review', 'compact', '$security-review', '$skill-creator'])).toEqual(['security-review', 'skill-creator'])
  })

  it('hasSkill matches a stored bare name against either spelling, only on an ok probe', () => {
    const claude = { engine: 'claude' as const, repo: '/r', names: ['simplify'], checkedAt: 't', state: 'ok' as const }
    const codex = { engine: 'codex' as const, repo: '/r', names: ['review', '$simplify'], checkedAt: 't', state: 'ok' as const }
    expect(hasSkill(claude, 'simplify')).toBe(true)
    expect(hasSkill(claude, '/simplify')).toBe(true)
    expect(hasSkill(codex, 'simplify')).toBe(true)
    expect(hasSkill(codex, 'review')).toBe(false) // a Codex built-in is not a skill
    expect(hasSkill({ ...claude, state: 'checking' }, 'simplify')).toBe(false)
    expect(hasSkill(undefined, 'simplify')).toBe(false)
  })
})

describe('probeCommands — open a session, read the list, close', () => {
  it('returns the announced names without sending a prompt', async () => {
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'probe-')), 'out.ndjson'); tmp.push(path.dirname(out))
    const cfg = fakeConfig({ turns: [], availableCommands: ['simplify', 'compact'] })
    const res = await probeCommands({ ...cfg, env: () => ({ ...cfg.env!({}), LIMN_FAKE_ACP_OUT: out }) }, '/repo')
    expect(res).toEqual({ names: ['simplify', 'compact'] })
    const records = fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { event: string; meta?: unknown })
    expect(records.map((r) => r.event)).toEqual(['newSession'])
    // the probe sees the same (user-only) settings a real Claude turn will
    expect(records[0].meta).toEqual({ claudeCode: { options: { settingSources: ['user'] } } })
  })

  it('an agent that announces nothing yields an empty list, not an error', async () => {
    const res = await probeCommands(fakeConfig({ turns: [] }), '/repo', { timeoutMs: 300 })
    expect(res).toEqual({ names: [] })
  })

  it('an adapter that cannot start is a failed probe', async () => {
    const res = await probeCommands(fakeConfig({ turns: [] }, CLAUDE_ACP_CONFIG, '/nonexistent/adapter.js'), '/repo', { timeoutMs: 2000 })
    expect(res).toHaveProperty('error')
  })
})

describe('CommandCache — one record per engine per repo, in prefs', () => {
  it('round-trips and reports unknown for never-probed pairs', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-db-')); tmp.push(dir)
    const { db } = openDb(path.join(dir, 'db'))
    const cache = new CommandCache(db)
    expect(cache.get('/r', ['claude', 'codex']).map((a) => a.state)).toEqual(['unknown', 'unknown'])
    cache.set({ engine: 'claude', repo: '/r', names: ['simplify'], checkedAt: 't1', state: 'ok' })
    cache.set({ engine: 'codex', repo: '/r', names: [], checkedAt: 't2', state: 'empty' })
    cache.set({ engine: 'claude', repo: '/other', names: ['security-review', 'simplify'], checkedAt: 't3', state: 'ok' })
    expect(cache.get('/r', ['claude', 'codex'])).toEqual([
      { engine: 'claude', repo: '/r', names: ['simplify'], checkedAt: 't1', state: 'ok' },
      { engine: 'codex', repo: '/r', names: [], checkedAt: 't2', state: 'empty' }
    ])
    // the editor's "seen on" list: skills across every repo, deduped and sorted
    expect(cache.seen()).toEqual([{ engine: 'claude', names: ['security-review', 'simplify'] }, { engine: 'codex', names: [] }])
    // a probe in flight shows as checking without touching the stored record
    cache.markChecking('codex', '/r', true)
    expect(cache.get('/r', ['codex'])[0].state).toBe('checking')
    cache.markChecking('codex', '/r', false)
    expect(cache.get('/r', ['codex'])[0].state).toBe('empty')
  })
})

describe('CommandProber — dedupes in-flight probes and stores the outcome', () => {
  it('stores ok / empty / failed per engine and returns the fresh records', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prober-')); tmp.push(dir)
    const { db } = openDb(path.join(dir, 'db'))
    const cache = new CommandCache(db)
    const configs = {
      claude: fakeConfig({ turns: [], availableCommands: ['simplify'] }),
      codex: fakeConfig({ turns: [] }, CODEX_ACP_CONFIG, '/nonexistent/adapter.js')
    }
    const prober = new CommandProber(cache, configs, { timeoutMs: 1500 })
    const p1 = prober.run('/repo', ['claude', 'codex'])
    const p2 = prober.run('/repo', ['claude']) // joins the in-flight claude probe
    expect(cache.get('/repo', ['claude'])[0].state).toBe('checking')
    const [a, b] = await Promise.all([p1, p2])
    expect(a.find((x) => x.engine === 'claude')).toMatchObject({ names: ['simplify'], state: 'ok' })
    expect(a.find((x) => x.engine === 'codex')).toMatchObject({ names: [], state: 'failed' })
    expect(b[0]).toMatchObject({ engine: 'claude', state: 'ok' })
    expect(cache.get('/repo', ['claude', 'codex']).map((x) => x.state)).toEqual(['ok', 'failed'])
  })
})
