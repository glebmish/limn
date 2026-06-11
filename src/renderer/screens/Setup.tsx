import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { I } from '../kit'
import type { EngineId } from '../../shared/types'

export default function Setup() {
  const { repo, repoInfo, branch, base, engine, error, setBranch, setBase, setEngine, startReview } = useStore()
  const [auth, setAuth] = useState<Record<EngineId, { ok: boolean; hint: string } | null>>({ claude: null, codex: null })
  const [starting, setStarting] = useState(false)

  useEffect(() => {
    for (const e of ['claude', 'codex'] as EngineId[]) {
      void window.api.authStatus(e).then((s) => setAuth((a) => ({ ...a, [e]: s })))
    }
  }, [])

  if (!repoInfo) return null
  const branches = repoInfo.branches

  return (
    <>
      <div className="wf-titlebar">
        <span className="wf-title"><b>local-review</b></span>
        <span className="grow"></span>
        <button className="btn btn-sm btn-ghost" onClick={() => useStore.setState({ screen: 'welcome' })}>
          Change repository
        </button>
      </div>
      <div className="lr-center">
        <div className="lr-card">
          <div className="lr-logo">
            <span className="mark"><I.branch style={{ width: 15, height: 15 }} /></span>
            <h1>{repo?.split('/').pop()}</h1>
          </div>
          <div className="lr-repo-path">{repo}</div>

          <div className="lr-field">
            <label>Branch to review</label>
            <select value={branch} onChange={(e) => setBranch(e.target.value)}>
              {branches.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </div>
          <div className="lr-field">
            <label>Against base</label>
            <select value={base} onChange={(e) => setBase(e.target.value)}>
              {branches.filter((b) => b !== branch).map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </div>

          <div className="lr-field">
            <label>Review agent</label>
            <div className="lr-engines">
              {(['claude', 'codex'] as EngineId[]).map((e) => (
                <button key={e} className={'lr-engine' + (engine === e ? ' on' : '')} onClick={() => setEngine(e)}>
                  <span className="en-name">
                    <span className={'en-dot ' + (auth[e] ? (auth[e]!.ok ? 'ok' : 'bad') : '')}></span>
                    {e === 'claude' ? 'Claude' : 'Codex'}
                  </span>
                  <div className="en-hint">{auth[e]?.hint ?? 'checking…'}</div>
                </button>
              ))}
            </div>
          </div>

          <div className="lr-actions">
            <button
              className="btn btn-primary btn-lg"
              disabled={starting || !branch || !base || branch === base}
              onClick={() => {
                setStarting(true)
                void startReview().finally(() => setStarting(false))
              }}
            >
              {starting ? 'Loading…' : 'Start review'}
              <I.chevR style={{ width: 13, height: 13 }} />
            </button>
          </div>
          {error && <div className="lr-error">{error}</div>}
        </div>
      </div>
    </>
  )
}
