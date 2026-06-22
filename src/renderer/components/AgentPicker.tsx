import { useEffect, useRef, useState } from 'react'
import type { AgentRef, EngineId, ReasoningEffort } from '../../shared/types'
import { AGENT_CATALOG, modelsFor, modelOption, engineLabel } from '../../shared/agents'
import { I, EngineGlyph } from '../kit'

/** Agent selector: a single trigger that summarizes the agent, opening a
 *  structured popover (engine + auth, model guidance, reasoning effort). Effort
 *  is shown for whichever engine/model declares it — Claude Opus/Sonnet and all
 *  Codex models — and hidden for "Auto" and Haiku. Replaces the old three bare
 *  <select>s. */
export function AgentPicker({ value, onChange, disabled, align = 'right' }: {
  value: AgentRef
  onChange: (a: AgentRef) => void
  disabled?: boolean
  /** which edge the popover anchors to. 'right' (default) suits a right-sidebar
   *  trigger; 'left' opens rightward for triggers near a clipped column's left edge. */
  align?: 'left' | 'right'
}) {
  const [open, setOpen] = useState(Boolean(window.lrDev?.openPicker))
  const [auth, setAuth] = useState<Record<EngineId, { ok: boolean; hint: string } | null>>({ claude: null, codex: null })
  const wrap = useRef<HTMLDivElement>(null)

  useEffect(() => {
    for (const e of ['claude', 'codex'] as EngineId[]) {
      void window.api.authStatus(e).then((s) => setAuth((a) => ({ ...a, [e]: s })))
    }
  }, [])

  // dev-only: drive the real onChange once so a static capture can show selection
  const devPicked = useRef(false)
  useEffect(() => {
    const e = window.lrDev?.pickEngine
    if (e && !devPicked.current) { devPicked.current = true; onChange({ engine: e as EngineId }) }
  }, [onChange])

  useEffect(() => {
    if (!open) return
    const off = (e: PointerEvent): void => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', off, true)
    return () => document.removeEventListener('pointerdown', off, true)
  }, [open])

  const model = modelOption(value)
  const efforts = model?.reasoningEfforts
  const sub = (value.model ? model?.label ?? value.model : 'Auto') + (value.reasoningEffort ? ` (${value.reasoningEffort})` : '')

  return (
    <div className="ag-wrap" ref={wrap}>
      <button className="ag-trigger" disabled={disabled} onClick={() => setOpen((o) => !o)} aria-label="agent">
        <EngineGlyph engine={value.engine} style={{ width: 13, height: 13, flex: '0 0 auto', color: 'var(--accent)' }} />
        {engineLabel(value.engine)}
        <span className="ag-sub">· {sub}</span>
        {open ? <I.chevD className="ag-cv" style={{ width: 12, height: 12 }} /> : <I.chevR className="ag-cv" style={{ width: 12, height: 12 }} />}
      </button>

      {open && (
        <div className={'ag-pop' + (align === 'left' ? ' ag-pop--left' : '')}>
          <div className="ag-sec">Engine</div>
          {AGENT_CATALOG.map((c) => {
            const st = auth[c.engine]
            const on = value.engine === c.engine
            return (
              <div key={c.engine} className={'ag-opt' + (on ? ' on' : '')} onClick={() => onChange({ engine: c.engine })}>
                <EngineGlyph engine={c.engine} style={{ width: 16, height: 16, flex: '0 0 auto' }} />
                <div className="ao-main">
                  <div className="ao-name">{c.label}</div>
                  <div className={'ao-desc' + (st && !st.ok ? ' ao-auth bad' : '')}>{st?.hint ?? 'checking…'}</div>
                </div>
                {on && <I.check className="ao-check" style={{ width: 13, height: 13 }} />}
              </div>
            )
          })}

          <div className="ag-div" />
          <div className="ag-sec">Model</div>
          {[{ id: undefined as string | undefined, label: 'Auto', desc: 'Let the CLI pick its default' },
            ...modelsFor(value.engine).map((m) => ({ id: m.id, label: m.label, desc: m.reasoningEfforts ? 'Supports reasoning effort' : 'Fast · no effort knob' }))
          ].map((m) => {
            const on = (value.model ?? '') === (m.id ?? '')
            return (
              <div key={m.id ?? 'auto'} className={'ag-opt' + (on ? ' on' : '')}
                onClick={() => onChange({ engine: value.engine, model: m.id })}>
                <span style={{ width: 16, flex: '0 0 auto' }} />
                <div className="ao-main">
                  <div className="ao-name">{m.label}{m.id === undefined && <span className="ao-fallback">fallback</span>}</div>
                  <div className="ao-desc">{m.desc}</div>
                </div>
                {on && <I.check className="ao-check" style={{ width: 13, height: 13 }} />}
              </div>
            )
          })}

          {efforts && (
            <>
              <div className="ag-sec">Reasoning effort</div>
              <div className="ag-effort">
                <div className="seg">
                  {efforts.map((r: ReasoningEffort) => (
                    <button key={r} className={value.reasoningEffort === r ? 'on' : ''}
                      onClick={() => onChange({ ...value, reasoningEffort: r })}>{r}</button>
                  ))}
                </div>
              </div>
            </>
          )}

          <div className="ag-note">Model + effort pass straight to the engine. <b>Auto</b> preserves today's behavior.</div>
        </div>
      )}
    </div>
  )
}
