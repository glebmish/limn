import { useEffect, useRef, useState } from 'react'
import { EngineGlyph, I } from '../kit'
import { ENGINE_PATH_PREF_KEYS, resolveDefaultAgent } from '../../shared/prefs'
import type { AgentRef } from '../../shared/types'
import { api } from '../lib/api'
import { AgentPicker } from './AgentPicker'
import { useStore } from '../store'

type EngineStatus = { ok: boolean; hint: string }

// Pure wrap logic for the modal's Tab trap: given the focusable elements in
// tab order and the currently focused one, return where focus should jump to
// keep it inside the dialog, or null to let the browser handle it normally.
// Shift+Tab off the first wraps to the last; Tab off the last wraps to the first.
export function nextTrapTarget(
  focusables: HTMLElement[],
  current: EventTarget | null,
  shift: boolean
): HTMLElement | null {
  if (focusables.length === 0) return null
  const first = focusables[0]
  const last = focusables[focusables.length - 1]
  if (shift && current === first) return last
  if (!shift && current === last) return first
  return null
}

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
  const [draftAgent, setDraftAgent] = useState<AgentRef>(() => useStore.getState().defaultAgent)
  const [claudePath, setClaudePath] = useState('')
  const [codexPath, setCodexPath] = useState('')
  const [claudeStatus, setClaudeStatus] = useState<EngineStatus | null>(null)
  const [codexStatus, setCodexStatus] = useState<EngineStatus | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const modalRef = useRef<HTMLDivElement>(null)

  // a11y: move focus into the dialog on open (first field beats the container for
  // an editor), and restore it to whatever opened us on close. The dialog is
  // conditionally rendered by App, so unmount === close for every path (Escape,
  // ✕, Cancel, backdrop). Guard the opener in case it was detached meanwhile.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    const first = modalRef.current?.querySelector<HTMLElement>('#settings-claude')
      ?? modalRef.current?.querySelector<HTMLElement>('input, button, [tabindex="0"]')
    first?.focus()
    return () => {
      if (opener?.isConnected) opener.focus()
    }
  }, [])

  const refreshStatus = async (): Promise<void> => {
    const [claude, codex] = await Promise.all([
      api().authStatus('claude'),
      api().authStatus('codex')
    ])
    setClaudeStatus(claude)
    setCodexStatus(codex)
  }

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const prefs = await api().getPrefs()
        if (!alive) return
        setClaudePath(prefs[ENGINE_PATH_PREF_KEYS.claude] ?? '')
        setCodexPath(prefs[ENGINE_PATH_PREF_KEYS.codex] ?? '')
        setDraftAgent(resolveDefaultAgent(prefs))
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
      // allSettled, not all: a rejected `setDefaultAgent` (bad agent ref) must not
      // hide that the path prefs wrote fine, and vice versa — every write gets a
      // chance to land, and every failure gets surfaced.
      const results = await Promise.allSettled([
        api().setPref(ENGINE_PATH_PREF_KEYS.claude, claudePath.trim()),
        api().setPref(ENGINE_PATH_PREF_KEYS.codex, codexPath.trim()),
        useStore.getState().setDefaultAgent(draftAgent)
      ])
      // Collect the write errors BEFORE refreshStatus() runs — refreshStatus can
      // itself throw, and if it did after this point it would jump straight to
      // the outer catch and discard whatever `results` already told us.
      const errors = results
        .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
        .map((r) => (r.reason instanceof Error ? r.reason.message : String(r.reason)))
      try {
        await refreshStatus()
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err))
      }
      if (errors.length > 0) {
        setError(errors.join('; '))
      } else {
        setSaved(true)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="settings-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div
        ref={modalRef}
        className="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onKeyDown={(e) => {
          if (e.key !== 'Tab') return
          const focusables = Array.from(
            modalRef.current?.querySelectorAll<HTMLElement>(
              'button:not([disabled]), input:not([disabled]), [tabindex="0"]'
            ) ?? []
          )
          const target = nextTrapTarget(focusables, document.activeElement, e.shiftKey)
          if (target) {
            e.preventDefault()
            target.focus()
          }
        }}
      >
        <div className="settings-head">
          <div>
            <div className="eyebrow">Settings</div>
            <h2 id="settings-title">Agents</h2>
          </div>
          <button className="btn btn-sm btn-ghost settings-close" onClick={onClose} title="Close settings">
            <I.x style={{ width: 13, height: 13 }} />
          </button>
        </div>

        <div className="settings-body">
          <div className="settings-field">
            <label id="settings-default-agent-label">Default review agent</label>
            <AgentPicker value={draftAgent} onChange={(a) => { setDraftAgent(a); setSaved(false) }} align="left" labelledBy="settings-default-agent-label" />
          </div>
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
