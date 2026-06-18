import type { AgentRef, EngineId, ReasoningEffort } from '../../shared/types'
import { AGENT_CATALOG, modelsFor } from '../../shared/agents'

/** Inline engine × model (× Codex reasoning effort) selector. Picking a model is
 *  "Auto" by default, which lets the CLI choose — preserving prior behavior. */
export function AgentPicker({ value, onChange, disabled }: {
  value: AgentRef
  onChange: (a: AgentRef) => void
  disabled?: boolean
}) {
  const models = modelsFor(value.engine)
  const model = models.find((m) => m.id === value.model)
  return (
    <div className="agent-pick">
      <select
        className="agent-sel" disabled={disabled} aria-label="engine" value={value.engine}
        onChange={(e) => onChange({ engine: e.target.value as EngineId })}
      >
        {AGENT_CATALOG.map((c) => <option key={c.engine} value={c.engine}>{c.label}</option>)}
      </select>
      <select
        className="agent-sel" disabled={disabled} aria-label="model" value={value.model ?? ''}
        onChange={(e) => onChange({ engine: value.engine, model: e.target.value || undefined })}
      >
        <option value="">Auto</option>
        {models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
      </select>
      {model?.reasoningEfforts && (
        <select
          className="agent-sel" disabled={disabled} aria-label="reasoning effort"
          value={value.reasoningEffort ?? ''}
          onChange={(e) => onChange({ ...value, reasoningEffort: (e.target.value || undefined) as ReasoningEffort | undefined })}
        >
          <option value="">effort: auto</option>
          {model.reasoningEfforts.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
      )}
    </div>
  )
}
