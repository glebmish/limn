import { useState } from 'react'
import { ACCENTS, useStore, type Density, type Guidance } from '../store'
import { I } from '../kit'

function Radio<T extends string>({ label, value, options, onChange }: {
  label: string
  value: T
  options: T[]
  onChange: (v: T) => void
}) {
  return (
    <div className="tweak-row">
      <div className="tw-lab">{label}</div>
      <span className="seg">
        {options.map((o) => (
          <button key={o} className={value === o ? 'on' : ''} onClick={() => onChange(o)}>{o}</button>
        ))}
      </span>
    </div>
  )
}

export function Tweaks() {
  const [open, setOpen] = useState(false)
  const { density, guidance, accent, setTweak } = useStore()

  return (
    <>
      <button className="tweaks-toggle" title="Tweaks" onClick={() => setOpen((o) => !o)}>
        {open ? <I.x style={{ width: 13, height: 13 }} /> : <I.gear style={{ width: 15, height: 15 }} />}
      </button>
      {open && (
        <div className="tweaks-panel">
          <div className="tweak-sec">Reading</div>
          <Radio<Density> label="Density" value={density} options={['compact', 'comfortable', 'spacious']} onChange={(v) => setTweak('density', v)} />
          <div className="tweak-sec">Agent presence</div>
          <Radio<Guidance> label="Guidance" value={guidance} options={['minimal', 'guided', 'narrated']} onChange={(v) => setTweak('guidance', v)} />
          <div className="tweak-hint">How much the agent explains: bare diffs → diagrams &amp; flags → plain-language walkthrough.</div>
          <div className="tweak-sec">Mood</div>
          <div className="tweak-colors">
            {ACCENTS.map((a) => (
              <button
                key={a[0]}
                className={'tweak-color' + (accent[0] === a[0] ? ' on' : '')}
                style={{ background: a[0] }}
                onClick={() => setTweak('accent', a)}
              />
            ))}
          </div>
        </div>
      )}
    </>
  )
}
