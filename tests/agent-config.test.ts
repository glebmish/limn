import { describe, it, expect } from 'vitest'
import { applyConfigChange, formatConfig } from '../src/shared/agentConfig'
import type { AgentRef } from '../src/shared/types'

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
