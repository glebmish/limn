import { useEffect, useState } from 'react'
import { EngineGlyph, I } from '../kit'
import { ENGINE_PATH_PREF_KEYS } from '../../shared/prefs'

type EngineStatus = { ok: boolean; hint: string }

function PathField({ engine, label, value, status, onChange }: {
  engine: 'claude' | 'codex'
  label: string
  value: string
  status: EngineStatus | null
  onChange: (value: string) => void
}) {
  return (
    <div className="settings-field">
      <label htmlFor={`settings-${engine}`}>
        <EngineGlyph engine={engine} />{label}
      </label>
      <div className="settings-path-row">
        <input
          id={`settings-${engine}`}
          value={value}
          spellCheck={false}
          placeholder={`/absolute/path/to/${engine}`}
          onChange={(e) => onChange(e.target.value)}
        />
        {value.trim() && (
          <button className="btn btn-sm btn-ghost settings-clear" onClick={() => onChange('')} title="Use PATH default">
            <I.x style={{ width: 12, height: 12 }} />
          </button>
        )}
      </div>
      <div className={'settings-status' + (status?.ok ? ' ok' : status ? ' bad' : '')}>
        <span className="settings-dot" />
        <span>{status?.hint ?? 'Checking…'}</span>
      </div>
    </div>
  )
}

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const [claudePath, setClaudePath] = useState('')
  const [codexPath, setCodexPath] = useState('')
  const [claudeStatus, setClaudeStatus] = useState<EngineStatus | null>(null)
  const [codexStatus, setCodexStatus] = useState<EngineStatus | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refreshStatus = async (): Promise<void> => {
    const [claude, codex] = await Promise.all([
      window.api.authStatus('claude'),
      window.api.authStatus('codex')
    ])
    setClaudeStatus(claude)
    setCodexStatus(codex)
  }

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const prefs = await window.api.getPrefs()
        if (!alive) return
        setClaudePath(prefs[ENGINE_PATH_PREF_KEYS.claude] ?? '')
        setCodexPath(prefs[ENGINE_PATH_PREF_KEYS.codex] ?? '')
        await refreshStatus()
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : String(err))
      }
    })()
    return () => { alive = false }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const save = async (): Promise<void> => {
    setSaving(true)
    setSaved(false)
    setError(null)
    try {
      await Promise.all([
        window.api.setPref(ENGINE_PATH_PREF_KEYS.claude, claudePath.trim()),
        window.api.setPref(ENGINE_PATH_PREF_KEYS.codex, codexPath.trim())
      ])
      await refreshStatus()
      setSaved(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="settings-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <div className="settings-head">
          <div>
            <div className="eyebrow">Settings</div>
            <h2 id="settings-title">Agent Paths</h2>
          </div>
          <button className="btn btn-sm btn-ghost settings-close" onClick={onClose} title="Close settings">
            <I.x style={{ width: 13, height: 13 }} />
          </button>
        </div>

        <div className="settings-body">
          <PathField engine="claude" label="Claude executable" value={claudePath} status={claudeStatus} onChange={(v) => { setClaudePath(v); setSaved(false) }} />
          <PathField engine="codex" label="Codex executable" value={codexPath} status={codexStatus} onChange={(v) => { setCodexPath(v); setSaved(false) }} />
          {error && <div className="limn-error settings-error">{error}</div>}
        </div>

        <div className="settings-foot">
          <span className="settings-note">{saved ? 'Saved' : 'Blank fields use PATH'}</span>
          <span className="grow" />
          <button className="btn btn-sm btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-sm btn-primary" disabled={saving} onClick={() => void save()}>
            <I.check style={{ width: 12, height: 12 }} />{saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
