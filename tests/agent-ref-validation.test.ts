import { describe, expect, it } from 'vitest'
import { validateAgentRef, validateAgentRefJson } from '../src/shared/agents'
import { DEFAULT_AGENT_PREF_KEY, LEGACY_AGENT_PREF_KEY, resolveDefaultAgent } from '../src/shared/prefs'

describe('validateAgentRef', () => {
  it('accepts engine-only (Auto model)', () => {
    expect(validateAgentRef({ engine: 'claude' })).toEqual({ ok: true, agent: { engine: 'claude' } })
  })

  it('accepts a valid engine+model', () => {
    expect(validateAgentRef({ engine: 'codex', model: 'gpt-5.5' }))
      .toEqual({ ok: true, agent: { engine: 'codex', model: 'gpt-5.5' } })
  })

  it('accepts a valid engine+model+reasoningEffort', () => {
    expect(validateAgentRef({ engine: 'claude', model: 'opus', reasoningEffort: 'max' }))
      .toEqual({ ok: true, agent: { engine: 'claude', model: 'opus', reasoningEffort: 'max' } })
  })

  it('drops unknown extra properties and omits absent keys (normalised)', () => {
    const result = validateAgentRef({ engine: 'claude', bogus: 'x' })
    expect(result).toEqual({ ok: true, agent: { engine: 'claude' } })
    if (result.ok) {
      expect('model' in result.agent).toBe(false)
      expect('reasoningEffort' in result.agent).toBe(false)
      expect('bogus' in result.agent).toBe(false)
    }
  })

  it('rejects non-object input', () => {
    expect(validateAgentRef('nope')).toEqual({ ok: false, error: 'unknown engine "undefined" (claude, codex)' })
    expect(validateAgentRef(null)).toEqual({ ok: false, error: 'unknown engine "undefined" (claude, codex)' })
  })

  it('rejects missing engine', () => {
    expect(validateAgentRef({})).toEqual({ ok: false, error: 'unknown engine "undefined" (claude, codex)' })
  })

  it('rejects an unknown engine', () => {
    expect(validateAgentRef({ engine: 'gemini' }))
      .toEqual({ ok: false, error: 'unknown engine "gemini" (claude, codex)' })
  })

  it('rejects a model not offered for the engine', () => {
    expect(validateAgentRef({ engine: 'claude', model: 'gpt-5.5' }))
      .toEqual({ ok: false, error: 'unknown model "gpt-5.5" for claude (opus, sonnet, haiku)' })
  })

  it('rejects a reasoningEffort on a model with no effort ladder', () => {
    expect(validateAgentRef({ engine: 'claude', model: 'haiku', reasoningEffort: 'low' }))
      .toEqual({ ok: false, error: 'model "haiku" has no reasoning-effort setting' })
  })

  it('rejects a reasoningEffort without a model', () => {
    expect(validateAgentRef({ engine: 'claude', reasoningEffort: 'low' }))
      .toEqual({ ok: false, error: 'reasoning effort needs a model (set a model first)' })
  })

  it('rejects an effort not in the model ladder', () => {
    expect(validateAgentRef({ engine: 'claude', model: 'opus', reasoningEffort: 'ultra' }))
      .toEqual({ ok: false, error: 'unknown effort "ultra" for opus (low, medium, high, xhigh, max)' })
  })
})

describe('validateAgentRefJson', () => {
  it('accepts valid JSON, returning a normalised agent', () => {
    expect(validateAgentRefJson('{"engine":"codex","model":"gpt-5.5"}'))
      .toEqual({ ok: true, agent: { engine: 'codex', model: 'gpt-5.5' } })
  })

  it('rejects invalid JSON with a single guard message', () => {
    expect(validateAgentRefJson('not json')).toEqual({ ok: false, error: 'invalid JSON for defaultAgent' })
  })

  it('rejects valid JSON that fails ref validation, with the validator message', () => {
    expect(validateAgentRefJson('{"engine":"nope"}'))
      .toEqual({ ok: false, error: 'unknown engine "nope" (claude, codex)' })
  })
})

describe('resolveDefaultAgent', () => {
  it('falls back to defaultAgent(claude) when nothing is set', () => {
    expect(resolveDefaultAgent({})).toEqual({ engine: 'claude' })
  })

  it('uses a valid defaultAgent pref', () => {
    expect(resolveDefaultAgent({ [DEFAULT_AGENT_PREF_KEY]: '{"engine":"codex"}' }))
      .toEqual({ engine: 'codex' })
  })

  it('falls back to the legacy agent pref when defaultAgent is absent', () => {
    expect(resolveDefaultAgent({ [LEGACY_AGENT_PREF_KEY]: '{"engine":"codex","model":"gpt-5.4"}' }))
      .toEqual({ engine: 'codex', model: 'gpt-5.4' })
  })

  it('prefers legacy agent over an invalid defaultAgent', () => {
    expect(resolveDefaultAgent({ [DEFAULT_AGENT_PREF_KEY]: 'junk', [LEGACY_AGENT_PREF_KEY]: '{"engine":"codex"}' }))
      .toEqual({ engine: 'codex' })
  })

  it('falls back to defaultAgent(claude) when defaultAgent is invalid and there is no legacy pref', () => {
    expect(resolveDefaultAgent({ [DEFAULT_AGENT_PREF_KEY]: '{"engine":"nope"}' })).toEqual({ engine: 'claude' })
  })

  it('never throws on garbage input', () => {
    expect(() => resolveDefaultAgent({ [DEFAULT_AGENT_PREF_KEY]: 'not json at all' })).not.toThrow()
  })
})
