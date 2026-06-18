import type { AgentRef, EngineId, ReasoningEffort } from './types.js'

// Curated catalog of selectable (engine × model) agents. Model ids are passed
// straight to each SDK's `model` option, so the lists can be tuned here without
// any schema/IPC change. `model: undefined` ("Auto") means "let the CLI pick its
// default" — preserving the app's original no-model-selected behavior.

export interface ModelOption { id: string; label: string; reasoningEfforts?: ReasoningEffort[] }
export interface EngineCatalog { engine: EngineId; label: string; models: ModelOption[] }

export const AGENT_CATALOG: EngineCatalog[] = [
  {
    engine: 'claude',
    label: 'Claude',
    models: [
      { id: 'opus', label: 'Opus' },
      { id: 'sonnet', label: 'Sonnet' },
      { id: 'haiku', label: 'Haiku' }
    ]
  },
  {
    engine: 'codex',
    label: 'Codex',
    models: [
      { id: 'gpt-5-codex', label: 'GPT-5 Codex', reasoningEfforts: ['low', 'medium', 'high'] },
      { id: 'gpt-5', label: 'GPT-5', reasoningEfforts: ['low', 'medium', 'high'] }
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
