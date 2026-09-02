import { validateAgentRef } from './agents.js'
import type { AgentRef } from './types.js'

export type ConfigKey = 'agent' | 'model' | 'effort'

/** Pure: apply one key change to an AgentRef, returning a validated next ref (or the
 *  validation error) plus an optional note when a change silently drops a value that
 *  no longer applies (an engine switch resets model/effort; a model switch that can't
 *  keep the current effort resets effort). */
export function applyConfigChange(current: AgentRef, key: ConfigKey, value: string): { ok: true; agent: AgentRef; note?: string } | { ok: false; error: string } {
  if (key === 'agent') {
    const check = validateAgentRef({ engine: value })
    if (!check.ok) return { ok: false, error: check.error }
    const nextEngine = check.agent.engine
    if (nextEngine === current.engine) return { ok: true, agent: current }
    const hadExtra = current.model !== undefined || current.reasoningEffort !== undefined
    return {
      ok: true,
      agent: { engine: nextEngine },
      note: hadExtra ? `model and effort reset to auto (not available for ${nextEngine})` : undefined
    }
  }

  if (key === 'model') {
    if (value === 'auto') return { ok: true, agent: { engine: current.engine } }
    const withEffort = validateAgentRef({ engine: current.engine, model: value, reasoningEffort: current.reasoningEffort })
    if (withEffort.ok) return { ok: true, agent: withEffort.agent }
    if (current.reasoningEffort === undefined) return { ok: false, error: withEffort.error }
    // the model itself may still be fine — it's just incompatible with the effort
    // that was set for the old model. Drop the effort rather than failing outright.
    const withoutEffort = validateAgentRef({ engine: current.engine, model: value })
    if (!withoutEffort.ok) return { ok: false, error: withEffort.error }
    return { ok: true, agent: withoutEffort.agent, note: `effort reset to auto (not available for ${value})` }
  }

  // key === 'effort'
  if (value === 'auto') {
    return { ok: true, agent: current.model !== undefined ? { engine: current.engine, model: current.model } : { engine: current.engine } }
  }
  const check = validateAgentRef({ engine: current.engine, model: current.model, reasoningEffort: value })
  if (!check.ok) return { ok: false, error: check.error }
  return { ok: true, agent: check.agent }
}

/** "agent   claude\nmodel   auto\neffort  auto" — labels padded to one column. */
export function formatConfig(agent: AgentRef): string {
  const rows: [string, string][] = [
    ['agent', agent.engine],
    ['model', agent.model ?? 'auto'],
    ['effort', agent.reasoningEffort ?? 'auto']
  ]
  return rows.map(([k, v]) => `${k.padEnd(8)}${v}`).join('\n')
}
