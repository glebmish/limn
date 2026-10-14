import { describe, expect, it } from 'vitest'
import { AGENT_CATALOG, modelsFor, modelOption, defaultAgent, agentLabel } from '../src/shared/agents'
import type { ReasoningEffort } from '../src/shared/types'

const CLAUDE_LADDER: ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']
const CODEX_MAX: ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']

describe('agent catalog', () => {
  it('offers Claude Fable/Opus/Sonnet as CLI aliases with the full low→max ladder', () => {
    expect(modelsFor('claude').map((m) => m.id)).toEqual(['fable', 'opus', 'sonnet', 'haiku'])
    for (const id of ['fable', 'opus', 'sonnet']) {
      expect(modelOption({ engine: 'claude', model: id })?.reasoningEfforts).toEqual(CLAUDE_LADDER)
    }
  })

  it('gives Claude Haiku no effort (the SDK errors on Haiku effort)', () => {
    expect(modelOption({ engine: 'claude', model: 'haiku' })?.reasoningEfforts).toBeUndefined()
  })

  it('serves the current Codex models, each with the ladder the CLI reports for it', () => {
    expect(modelsFor('codex').map((m) => m.id)).toEqual(['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-luna'])
    for (const m of modelsFor('codex')) expect(m.reasoningEfforts).toEqual(CODEX_MAX)
  })

  it('retires the stale gpt-5 / gpt-5-codex / gpt-5.4 slugs', () => {
    const codexIds = modelsFor('codex').map((m) => m.id)
    for (const stale of ['gpt-5', 'gpt-5-codex', 'gpt-5.4', 'gpt-5.4-mini']) expect(codexIds).not.toContain(stale)
  })

  it('gives every model a one-line description for the picker', () => {
    for (const cat of AGENT_CATALOG) {
      for (const m of cat.models) expect(m.desc, m.id).toMatch(/\S/)
    }
  })

  it('defaults to Auto (no model/effort), preserving prior behavior', () => {
    expect(defaultAgent('claude')).toEqual({ engine: 'claude' })
    expect(agentLabel({ engine: 'claude' })).toBe('Claude · Auto')
    expect(agentLabel({ engine: 'codex', model: 'gpt-6-astra', reasoningEffort: 'max' })).toBe('Codex · GPT-6 Astra (max)')
    expect(agentLabel({ engine: 'claude', model: 'fable', reasoningEffort: 'max' })).toBe('Claude · Fable (max)')
  })

  it('every catalog effort value is a valid ReasoningEffort', () => {
    const valid = new Set<ReasoningEffort>(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
    for (const cat of AGENT_CATALOG) {
      for (const m of cat.models) {
        for (const e of m.reasoningEfforts ?? []) expect(valid.has(e)).toBe(true)
      }
    }
  })
})
