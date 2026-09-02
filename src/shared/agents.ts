import type { AgentRef, EngineId, ReasoningEffort } from './types.js'

// Curated catalog of selectable (engine × model) agents. Model ids are passed
// straight to each SDK's `model` option, so the lists can be tuned here without
// any schema/IPC change. `model: undefined` ("Auto") means "let the CLI pick its
// default" — preserving the app's original no-model-selected behavior.

export interface ModelOption { id: string; label: string; reasoningEfforts?: ReasoningEffort[] }
export interface EngineCatalog { engine: EngineId; label: string; models: ModelOption[] }

// Per-model reasoning ladders. Claude Opus/Sonnet expose low→max via the agent
// SDK's `effort` option; Haiku does not support effort (the SDK errors), so it
// declares none. Codex spans low→xhigh ("Extra high"); `minimal` exists in the
// type but isn't offered in the UI.
const CLAUDE_EFFORTS: ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max']
const CODEX_EFFORTS: ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh']

export const AGENT_CATALOG: EngineCatalog[] = [
  {
    engine: 'claude',
    label: 'Claude',
    models: [
      { id: 'opus', label: 'Opus', reasoningEfforts: CLAUDE_EFFORTS },
      { id: 'sonnet', label: 'Sonnet', reasoningEfforts: CLAUDE_EFFORTS },
      { id: 'haiku', label: 'Haiku' }
    ]
  },
  {
    engine: 'codex',
    label: 'Codex',
    models: [
      { id: 'gpt-5.5', label: 'GPT-5.5', reasoningEfforts: CODEX_EFFORTS },
      { id: 'gpt-5.4', label: 'GPT-5.4', reasoningEfforts: CODEX_EFFORTS },
      { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini', reasoningEfforts: CODEX_EFFORTS }
    ]
  }
]

export function engineLabel(engine: EngineId): string {
  return AGENT_CATALOG.find((c) => c.engine === engine)?.label ?? engine
}

export function modelsFor(engine: EngineId): ModelOption[] {
  return AGENT_CATALOG.find((c) => c.engine === engine)?.models ?? []
}

export function modelOption(agent: AgentRef): ModelOption | undefined {
  return modelsFor(agent.engine).find((m) => m.id === agent.model)
}

/** The default agent for an engine: Auto model (CLI default). */
export function defaultAgent(engine: EngineId): AgentRef {
  return { engine }
}

/** Human label, e.g. "Claude · Opus" or "Claude · Auto". */
export function agentLabel(agent: AgentRef): string {
  const model = modelOption(agent)?.label ?? (agent.model ? agent.model : 'Auto')
  const effort = agent.reasoningEffort ? ` (${agent.reasoningEffort})` : ''
  return `${engineLabel(agent.engine)} · ${model}${effort}`
}

export function sameAgent(a: AgentRef, b: AgentRef): boolean {
  return a.engine === b.engine && (a.model ?? '') === (b.model ?? '') &&
    (a.reasoningEffort ?? '') === (b.reasoningEffort ?? '')
}

export type AgentRefCheck = { ok: true; agent: AgentRef } | { ok: false; error: string }

/** Validate an arbitrary value as an AgentRef against the catalog, returning a
 *  normalised ref (unknown extra properties dropped; `model`/`reasoningEffort`
 *  omitted, not left `undefined`, when absent). Used to gate persisted prefs. */
export function validateAgentRef(input: unknown): AgentRefCheck {
  const raw = (input && typeof input === 'object') ? input as Record<string, unknown> : {}
  const engine = raw.engine
  const catalog = AGENT_CATALOG.find((c) => c.engine === engine)
  if (!catalog) {
    const known = AGENT_CATALOG.map((c) => c.engine).join(', ')
    return { ok: false, error: `unknown engine "${String(engine)}" (${known})` }
  }

  const model = raw.model
  if (model === undefined) {
    if (raw.reasoningEffort !== undefined) {
      return { ok: false, error: 'reasoning effort needs a model (set a model first)' }
    }
    return { ok: true, agent: { engine: catalog.engine } }
  }

  const modelOpt = catalog.models.find((m) => m.id === model)
  if (!modelOpt) {
    const known = catalog.models.map((m) => m.id).join(', ')
    return { ok: false, error: `unknown model "${String(model)}" for ${catalog.engine} (${known})` }
  }

  const reasoningEffort = raw.reasoningEffort
  if (reasoningEffort === undefined) {
    return { ok: true, agent: { engine: catalog.engine, model: modelOpt.id } }
  }

  const efforts = modelOpt.reasoningEfforts
  if (!efforts || efforts.length === 0) {
    return { ok: false, error: `model "${modelOpt.id}" has no reasoning-effort setting` }
  }
  if (!efforts.includes(reasoningEffort as ReasoningEffort)) {
    return { ok: false, error: `unknown effort "${String(reasoningEffort)}" for ${modelOpt.id} (${efforts.join(', ')})` }
  }

  return { ok: true, agent: { engine: catalog.engine, model: modelOpt.id, reasoningEffort: reasoningEffort as ReasoningEffort } }
}

/** JSON-guard around `validateAgentRef`, so every call site that stores a
 *  `defaultAgent` pref as a JSON string (server `setPref`, the CLI's local
 *  store, the shared prefs resolver) shares one "invalid JSON" message
 *  instead of each throwing its own copy. */
export function validateAgentRefJson(value: string): AgentRefCheck {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return { ok: false, error: 'invalid JSON for defaultAgent' }
  }
  return validateAgentRef(parsed)
}
