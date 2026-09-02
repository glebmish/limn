import { defaultAgent, validateAgentRefJson } from './agents.js'
import type { AgentRef } from './types.js'

export const ENGINE_PATH_PREF_KEYS = {
  claude: 'engine.claude.path',
  codex: 'engine.codex.path'
} as const

/** Persisted default-agent pref (new) and its predecessor (kept for migration). */
export const DEFAULT_AGENT_PREF_KEY = 'defaultAgent'
export const LEGACY_AGENT_PREF_KEY = 'agent'

function parseValidAgent(json: string | undefined): AgentRef | undefined {
  if (json === undefined) return undefined
  const check = validateAgentRefJson(json)
  return check.ok ? check.agent : undefined
}

/** Resolve the reviewer's default agent from raw prefs: a valid `defaultAgent`
 *  wins, else a valid legacy `agent`, else `defaultAgent('claude')`. Never throws
 *  — any JSON/shape problem is treated as absent. */
export function resolveDefaultAgent(prefs: Record<string, string | undefined>): AgentRef {
  return parseValidAgent(prefs[DEFAULT_AGENT_PREF_KEY]) ??
    parseValidAgent(prefs[LEGACY_AGENT_PREF_KEY]) ??
    defaultAgent('claude')
}
