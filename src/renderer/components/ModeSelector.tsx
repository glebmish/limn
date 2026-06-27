import { useState } from 'react'
import { I } from '../kit'
import { usePopover } from '../lib/usePopover'
import { EXECUTION_TIERS } from '../../shared/executionMode'
import type { ExecutionMode } from '../../shared/types'
import { dev } from '../dev'

const TIER_ICON: Record<ExecutionMode, keyof typeof I> = {
  ask: 'lock', edits: 'edit', auto: 'unlock', full: 'warn',
}

/** Per-chat execution-mode pill + dropdown (wireframe J1). One product vocabulary;
 *  the engine mapping is internal. Never disabled by tier — `full` (sandbox off)
 *  takes a second confirming click. */
export function ModeSelector({ mode, disabled, onChange }: {
  mode: ExecutionMode
  disabled?: boolean
  onChange: (m: ExecutionMode) => void
}) {
  const [confirmFull, setConfirmFull] = useState(false)
  // opens upward by preference; flips down / clamps if the composer sits high
  const { open, toggle, close, anchorRef, floatingRef, popStyle: menuStyle } = usePopover<HTMLButtonElement, HTMLDivElement>({ side: 'top', align: 'start', defaultOpen: Boolean(dev.openMode), onClose: () => setConfirmFull(false) })

  const active = EXECUTION_TIERS.find((t) => t.key === mode) ?? EXECUTION_TIERS[0]
  const Trig = I[TIER_ICON[active.key]]

  const pick = (key: ExecutionMode): void => {
    if (key === 'full' && mode !== 'full' && !confirmFull) { setConfirmFull(true); return }
    onChange(key); close()
  }

  return (
    <div className="modebar">
      <button
        ref={anchorRef}
        className={'mode-trig ' + active.key}
        disabled={disabled}
        aria-expanded={open}
        onClick={() => { toggle(); setConfirmFull(false) }}
      >
        <Trig className="mt-ico" />
        {active.label}
        <span className="mt-car"><I.chevD style={{ width: 12, height: 12 }} /></span>
      </button>
      {open && (
        <div className="mode-menu" ref={floatingRef} style={menuStyle}>
          <div className="mm-hd">Execution mode</div>
          {EXECUTION_TIERS.map((t) => {
            const Ico = I[TIER_ICON[t.key]]
            const confirming = t.key === 'full' && confirmFull && mode !== 'full'
            return (
              <div key={t.key} role="button" tabIndex={0} className={'mode-opt' + (t.key === mode ? ' on' : '')} onClick={() => pick(t.key)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(t.key) } }}>
                <span className={'mo-ico' + (t.key === 'full' ? ' full' : '')}><Ico /></span>
                <div style={{ minWidth: 0 }}>
                  <div className="mo-tier">{t.label}</div>
                  <div className="mo-desc">{confirming ? 'Drops the sandbox (network + any file). Click again to confirm.' : t.desc}</div>
                </div>
                <span className="mo-chk"><I.check style={{ width: 13, height: 13 }} /></span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
