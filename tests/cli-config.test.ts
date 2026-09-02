import { describe, it, expect } from 'vitest'
import { applyConfigChange, formatConfig, runConfig, type ConfigDeps, type PrefsStore } from '../src/cli/config'
import type { AgentRef } from '../src/shared/types'
import type { ServiceTarget } from '../src/cli/target'
import type { Io } from '../src/cli/main'

const claude: ServiceTarget = { host: '127.0.0.1', port: 5466, token: '', url: 'http://limn.localhost:5466' }
const health = { app: 'limn' as const, version: '0.4.0', pid: 7, startedAt: new Date().toISOString(), port: 5466 }

function fakeIo(): Io & { out_: string[]; err_: string[] } {
  const out_: string[] = [], err_: string[] = []
  return { out_, err_, isTTY: false, out: (l) => { out_.push(l) }, err: (l) => { err_.push(l) }, ask: async () => false }
}

function fakeStore(initial: Record<string, string> = {}): PrefsStore & { calls: string[]; data: Record<string, string> } {
  const data = { ...initial }
  const calls: string[] = []
  return {
    data, calls,
    get: async () => { calls.push('get'); return { ...data } },
    set: async (key, value) => { calls.push(`set:${key}`); data[key] = value }
  }
}

describe('applyConfigChange', () => {
  const claudeOpusHigh: AgentRef = { engine: 'claude', model: 'opus', reasoningEffort: 'high' }

  it('agent -> codex resets model/effort with a note', () => {
    expect(applyConfigChange(claudeOpusHigh, 'agent', 'codex')).toEqual({
      ok: true,
      agent: { engine: 'codex' },
      note: 'model and effort reset to auto (not available for codex)'
    })
  })

  it('agent -> claude when already claude keeps model/effort and no note', () => {
    const r = applyConfigChange(claudeOpusHigh, 'agent', 'claude')
    expect(r).toEqual({ ok: true, agent: claudeOpusHigh })
    expect((r as { note?: string }).note).toBeUndefined()
  })

  it('agent -> unknown engine errors', () => {
    expect(applyConfigChange(claudeOpusHigh, 'agent', 'nope')).toEqual({ ok: false, error: 'unknown engine "nope" (claude, codex)' })
  })

  it('model -> a valid model on the current engine', () => {
    expect(applyConfigChange({ engine: 'codex' }, 'model', 'gpt-5.5')).toEqual({ ok: true, agent: { engine: 'codex', model: 'gpt-5.5' } })
  })

  it('model -> auto clears model and effort', () => {
    expect(applyConfigChange(claudeOpusHigh, 'model', 'auto')).toEqual({ ok: true, agent: { engine: 'claude' } })
  })

  it('effort -> a value with no model set errors', () => {
    expect(applyConfigChange({ engine: 'claude' }, 'effort', 'high')).toEqual({
      ok: false,
      error: 'reasoning effort needs a model (set a model first)'
    })
  })

  it('effort -> auto clears effort, keeping the model', () => {
    expect(applyConfigChange(claudeOpusHigh, 'effort', 'auto')).toEqual({ ok: true, agent: { engine: 'claude', model: 'opus' } })
  })

  it('model with no reasoning-effort setting then an effort change errors', () => {
    const afterModel = applyConfigChange(claudeOpusHigh, 'model', 'haiku')
    expect(afterModel).toEqual({ ok: true, agent: { engine: 'claude', model: 'haiku' }, note: 'effort reset to auto (not available for haiku)' })
    const agent = (afterModel as { agent: AgentRef }).agent
    expect(applyConfigChange(agent, 'effort', 'low')).toEqual({ ok: false, error: 'model "haiku" has no reasoning-effort setting' })
  })
})

describe('formatConfig', () => {
  it('formats the three rows aligned', () => {
    expect(formatConfig({ engine: 'claude' })).toBe('agent   claude\nmodel   auto\neffort  auto')
  })
})

describe('runConfig', () => {
  function deps(over: Partial<ConfigDeps> = {}): ConfigDeps {
    return {
      target: () => claude,
      probe: async () => null,
      remote: () => { throw new Error('remote store should not be used') },
      local: () => fakeStore(),
      ...over
    }
  }

  it('probe healthy uses the remote store and never local', async () => {
    const remote = fakeStore()
    let localCalled = false
    const io = fakeIo()
    const code = await runConfig({ kind: 'config-list' }, io, deps({
      probe: async () => health,
      remote: () => remote,
      local: () => { localCalled = true; return fakeStore() }
    }))
    expect(code).toBe(0)
    expect(remote.calls).toEqual(['get'])
    expect(localCalled).toBe(false)
  })

  it('probe null uses the local store', async () => {
    const local = fakeStore()
    const io = fakeIo()
    const code = await runConfig({ kind: 'config-list' }, io, deps({ probe: async () => null, local: () => local }))
    expect(code).toBe(0)
    expect(local.calls).toEqual(['get'])
  })

  it('list prints three aligned lines', async () => {
    const io = fakeIo()
    const store = fakeStore({ defaultAgent: JSON.stringify({ engine: 'codex', model: 'gpt-5.5' }) })
    await runConfig({ kind: 'config-list' }, io, deps({ local: () => store }))
    expect(io.out_).toEqual(['agent   codex\nmodel   gpt-5.5\neffort  auto'])
  })

  it('get prints the bare value', async () => {
    const io = fakeIo()
    const store = fakeStore({ defaultAgent: JSON.stringify({ engine: 'codex', model: 'gpt-5.5' }) })
    await runConfig({ kind: 'config-get', key: 'model' }, io, deps({ local: () => store }))
    expect(io.out_).toEqual(['gpt-5.5'])
  })

  it('set writes the normalised JSON pref and re-prints the list', async () => {
    const io = fakeIo()
    const store = fakeStore()
    const code = await runConfig({ kind: 'config-set', key: 'agent', value: 'codex' }, io, deps({ local: () => store }))
    expect(code).toBe(0)
    expect(store.calls).toEqual(['get', 'set:defaultAgent'])
    expect(store.data.defaultAgent).toBe(JSON.stringify({ engine: 'codex' }))
    expect(io.out_).toEqual(['agent   codex\nmodel   auto\neffort  auto'])
  })

  it('set prints a note ahead of the list when the change drops a value', async () => {
    const io = fakeIo()
    const store = fakeStore({ defaultAgent: JSON.stringify({ engine: 'claude', model: 'opus', reasoningEffort: 'high' }) })
    await runConfig({ kind: 'config-set', key: 'agent', value: 'codex' }, io, deps({ local: () => store }))
    expect(io.out_).toEqual([
      'note: model and effort reset to auto (not available for codex)',
      'agent   codex\nmodel   auto\neffort  auto'
    ])
  })

  it('an invalid set is rejected locally without writing', async () => {
    const io = fakeIo()
    const store = fakeStore()
    const code = await runConfig({ kind: 'config-set', key: 'agent', value: 'nope' }, io, deps({ local: () => store }))
    expect(code).toBe(1)
    expect(store.calls).toEqual(['get'])
    expect(io.err_).toEqual(['limn: unknown engine "nope" (claude, codex)'])
  })

  it('a remote set rejection prints the error and returns 1', async () => {
    const io = fakeIo()
    const remote = fakeStore()
    remote.set = async () => { throw new Error('unknown model "bogus" for codex (gpt-5.5, gpt-5.4, gpt-5.4-mini)') }
    const code = await runConfig({ kind: 'config-set', key: 'agent', value: 'codex' }, io, deps({ probe: async () => health, remote: () => remote }))
    expect(code).toBe(1)
    expect(io.err_).toEqual(['limn: unknown model "bogus" for codex (gpt-5.5, gpt-5.4, gpt-5.4-mini)'])
  })
})
