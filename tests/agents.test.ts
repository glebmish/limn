import { describe, expect, it } from 'vitest'
import { AGENT_CATALOG, modelsFor, modelOption, defaultAgent, agentLabel } from '../src/shared/agents'
import type { ReasoningEffort } from '../src/shared/types'

const CLAUDE_LADDER: ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']
const CODEX_LADDER: ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh']

describe('agent catalog', () => {
  it('offers Claude Opus/Sonnet the full low→max effort ladder', () => {
    expect(modelOption({ engine: 'claude', model: 'opus' })?.reasoningEfforts).toEqual(CLAUDE_LADDER)
    expect(modelOption({ engine: 'claude', model: 'sonnet' })?.reasoningEfforts).toEqual(CLAUDE_LADDER)
  })

  it('gives Claude Haiku no effort (the SDK errors on Haiku effort)', () => {
    expect(modelOption({ engine: 'claude', model: 'haiku' })?.reasoningEfforts).toBeUndefined()
  })

  it('serves the current Codex models (gpt-5.5 / gpt-5.4 / gpt-5.4-mini), capped at xhigh', () => {
    expect(modelsFor('codex').map((m) => m.id)).toEqual(['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini'])
    for (const m of modelsFor('codex')) {
      expect(m.reasoningEfforts).toEqual(CODEX_LADDER)
      expect(m.reasoningEfforts).not.toContain('max') // max is Claude-only
    }
  })

  it('retires the stale gpt-5 / gpt-5-codex slugs', () => {
    const codexIds = modelsFor('codex').map((m) => m.id)
    expect(codexIds).not.toContain('gpt-5')
    expect(codexIds).not.toContain('gpt-5-codex')
  })

  it('defaults to Auto (no model/effort), preserving prior behavior', () => {
    expect(defaultAgent('claude')).toEqual({ engine: 'claude' })
    expect(agentLabel({ engine: 'claude' })).toBe('Claude · Auto')
    expect(agentLabel({ engine: 'codex', model: 'gpt-5.5', reasoningEffort: 'xhigh' })).toBe('Codex · GPT-5.5 (xhigh)')
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
