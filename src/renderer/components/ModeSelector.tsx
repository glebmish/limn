import { useRef, useState } from 'react'
import { I } from '../kit'
import { useDismiss } from '../lib/useDismiss'
import { EXECUTION_TIERS } from '../../shared/executionMode'
import type { ExecutionMode } from '../../shared/types'

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
  const [open, setOpen] = useState(Boolean(window.limnDev?.openMode))
  const [confirmFull, setConfirmFull] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useDismiss(open, () => { setOpen(false); setConfirmFull(false) }, ref)

  const active = EXECUTION_TIERS.find((t) => t.key === mode) ?? EXECUTION_TIERS[0]
  const Trig = I[TIER_ICON[active.key]]

  const pick = (key: ExecutionMode): void => {
    if (key === 'full' && mode !== 'full' && !confirmFull) { setConfirmFull(true); return }
    onChange(key); setOpen(false); setConfirmFull(false)
  }

  return (
    <div className="modebar" ref={ref}>
      <button
        className={'mode-trig ' + active.key}
        disabled={disabled}
        onClick={() => { setOpen((o) => !o); setConfirmFull(false) }}
      >
        <Trig className="mt-ico" />
        {active.label}
        <span className="mt-car"><I.chevD style={{ width: 12, height: 12 }} /></span>
      </button>
      {open && (
        <div className="mode-menu">
          <div className="mm-hd">Execution mode</div>
          {EXECUTION_TIERS.map((t) => {
            const Ico = I[TIER_ICON[t.key]]
            const confirming = t.key === 'full' && confirmFull && mode !== 'full'
            return (
              <div key={t.key} className={'mode-opt' + (t.key === mode ? ' on' : '')} onClick={() => pick(t.key)}>
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
