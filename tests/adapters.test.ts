import { describe, it, expect, afterEach } from 'vitest'
import { CLAUDE_ACP_CONFIG, CODEX_ACP_CONFIG, claudeEffort, codexEffort } from '../src/server/engines/adapters'
import { setEngineBinaryPrefs } from '../src/server/engines/binaries'
import { ENGINE_PATH_PREF_KEYS } from '../src/shared/prefs'

// binaryEnv resolves through binaries.ts' module-level configured prefs; clear
// them after each test so a set path can't leak into unrelated cases.
afterEach(() => setEngineBinaryPrefs({}))

describe('CLAUDE_ACP_CONFIG', () => {
  it('env carries ANTHROPIC_MODEL when a model is set, empty otherwise', () => {
    expect(CLAUDE_ACP_CONFIG.env?.({ model: 'x' })).toEqual({ ANTHROPIC_MODEL: 'x' })
    expect(CLAUDE_ACP_CONFIG.env?.({})).toEqual({})
  })

  it('configOptions carries effort via configId "effort", clamping minimal -> low', () => {
    expect(CLAUDE_ACP_CONFIG.configOptions?.({ reasoningEffort: 'minimal' })).toEqual([{ configId: 'effort', value: 'low' }])
    expect(CLAUDE_ACP_CONFIG.configOptions?.({ reasoningEffort: 'high' })).toEqual([{ configId: 'effort', value: 'high' }])
    expect(CLAUDE_ACP_CONFIG.configOptions?.({})).toEqual([])
  })

  it('claudeEffort passes non-minimal values through unchanged', () => {
    expect(claudeEffort('minimal')).toBe('low')
    expect(claudeEffort('low')).toBe('low')
    expect(claudeEffort('medium')).toBe('medium')
    expect(claudeEffort('high')).toBe('high')
    expect(claudeEffort('xhigh')).toBe('xhigh')
    expect(claudeEffort('max')).toBe('max')
  })

  it('modeFor is unchanged for ask/edits/full, and for auto with no availableModes info (spike default)', () => {
    expect(CLAUDE_ACP_CONFIG.modeFor('ask', true)).toBe('default')
    expect(CLAUDE_ACP_CONFIG.modeFor('edits', true)).toBe('acceptEdits')
    expect(CLAUDE_ACP_CONFIG.modeFor('full', true)).toBe('bypassPermissions')
    expect(CLAUDE_ACP_CONFIG.modeFor('edits', false)).toBe('default')
    // no availableModes passed (undefined) -> optimistically try the engine's native auto
    expect(CLAUDE_ACP_CONFIG.modeFor('auto', true)).toBe('auto')
  })

  it('modeFor auto selects the native "auto" mode when the session advertises it', () => {
    expect(CLAUDE_ACP_CONFIG.modeFor('auto', true, ['default', 'acceptEdits', 'auto', 'bypassPermissions'])).toBe('auto')
  })

  it('modeFor auto falls back to acceptEdits when availableModes is present but lacks "auto"', () => {
    expect(CLAUDE_ACP_CONFIG.modeFor('auto', true, ['default', 'acceptEdits', 'bypassPermissions'])).toBe('acceptEdits')
  })

  it('modeFor auto with no write access still forces default, regardless of availableModes', () => {
    expect(CLAUDE_ACP_CONFIG.modeFor('auto', false, ['default', 'acceptEdits', 'auto', 'bypassPermissions'])).toBe('default')
  })

  it('modeFor full selects bypassPermissions when the session advertises it', () => {
    expect(CLAUDE_ACP_CONFIG.modeFor('full', true, ['default', 'acceptEdits', 'auto', 'bypassPermissions'])).toBe('bypassPermissions')
  })

  it('modeFor full falls back to auto when bypassPermissions is unavailable but auto is listed', () => {
    expect(CLAUDE_ACP_CONFIG.modeFor('full', true, ['default', 'acceptEdits', 'auto'])).toBe('auto')
  })

  it('modeFor full falls back to acceptEdits when neither bypassPermissions nor auto is listed', () => {
    expect(CLAUDE_ACP_CONFIG.modeFor('full', true, ['default', 'acceptEdits'])).toBe('acceptEdits')
  })

  it('binaryEnv points CLAUDE_CODE_EXECUTABLE at the resolved (Settings-configured) binary', () => {
    setEngineBinaryPrefs({ [ENGINE_PATH_PREF_KEYS.claude]: '/opt/claude' })
    expect(CLAUDE_ACP_CONFIG.binaryEnv?.()).toEqual({ CLAUDE_CODE_EXECUTABLE: '/opt/claude' })
  })
})

describe('CODEX_ACP_CONFIG', () => {
  it('modeFor maps the tier x write matrix to read-only/workspace-write/agent/agent-full-access', () => {
    expect(CODEX_ACP_CONFIG.modeFor('ask', true)).toBe('read-only')
    expect(CODEX_ACP_CONFIG.modeFor('edits', true)).toBe('workspace-write')
    expect(CODEX_ACP_CONFIG.modeFor('auto', true)).toBe('agent')
    expect(CODEX_ACP_CONFIG.modeFor('full', true)).toBe('agent-full-access')
    // no write -> read-only regardless of tier
    expect(CODEX_ACP_CONFIG.modeFor('edits', false)).toBe('read-only')
    expect(CODEX_ACP_CONFIG.modeFor('full', false)).toBe('read-only')
  })

  it('modeFor ignores availableModes (the pinned codex-acp always advertises all four modes)', () => {
    expect(CODEX_ACP_CONFIG.modeFor('auto', true, ['read-only', 'agent'])).toBe('agent')
    expect(CODEX_ACP_CONFIG.modeFor('auto', true, [])).toBe('agent')
    expect(CODEX_ACP_CONFIG.modeFor('auto', true, undefined)).toBe('agent')
  })

  it('has no model/effort spawn env (both go through config options)', () => {
    expect(CODEX_ACP_CONFIG.env).toBeUndefined()
  })

  it('binaryEnv points CODEX_PATH at the resolved (Settings-configured) binary', () => {
    setEngineBinaryPrefs({ [ENGINE_PATH_PREF_KEYS.codex]: '/opt/codex' })
    expect(CODEX_ACP_CONFIG.binaryEnv?.()).toEqual({ CODEX_PATH: '/opt/codex' })
  })

  it('hard-requires its native binary (bundled codex fallback is stripped); Claude self-discovers', () => {
    expect(CODEX_ACP_CONFIG.binaryRequired).toBe(true)
    expect(CLAUDE_ACP_CONFIG.binaryRequired).toBeUndefined()
  })

  it('configOptions yields model + reasoning_effort, passing max through (the catalog gates per model)', () => {
    expect(CODEX_ACP_CONFIG.configOptions?.({ model: 'gpt-6-astra', reasoningEffort: 'max' })).toEqual([
      { configId: 'model', value: 'gpt-6-astra' },
      { configId: 'reasoning_effort', value: 'max' }
    ])
  })

  it('configOptions omits an option when its turn value is unset', () => {
    expect(CODEX_ACP_CONFIG.configOptions?.({ model: 'gpt-5.5' })).toEqual([{ configId: 'model', value: 'gpt-5.5' }])
    expect(CODEX_ACP_CONFIG.configOptions?.({ reasoningEffort: 'high' })).toEqual([{ configId: 'reasoning_effort', value: 'high' }])
    expect(CODEX_ACP_CONFIG.configOptions?.({})).toEqual([])
  })

  it('codexEffort clamps only minimal -> low; max passes through', () => {
    expect(codexEffort('minimal')).toBe('low')
    expect(codexEffort('low')).toBe('low')
    expect(codexEffort('medium')).toBe('medium')
    expect(codexEffort('high')).toBe('high')
    expect(codexEffort('xhigh')).toBe('xhigh')
    expect(codexEffort('max')).toBe('max')
  })
})
