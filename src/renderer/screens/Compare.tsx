import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { I, ago, shortSha } from '../kit'
import type { EngineId } from '../../shared/types'
import { RefPicker } from '../components/RefPicker'
import { CompareDiff } from '../components/CompareDiff'

export default function Compare() {
  const { compare, engine, error, setEngine, setBaseInput, setCompareInput, swapRefs, startFromCompare, resumeExisting, startFresh, applyRetarget, backToDashboard } = useStore()
  const [auth, setAuth] = useState<Record<EngineId, { ok: boolean; hint: string } | null>>({ claude: null, codex: null })
  const [starting, setStarting] = useState(false)

  useEffect(() => {
    for (const e of ['claude', 'codex'] as EngineId[]) {
      void window.api.authStatus(e).then((s) => setAuth((a) => ({ ...a, [e]: s })))
    }
  }, [])

  const { repo, baseInput, compareInput, data, loading, retargetSessionId } = compare
  if (!repo) return null
  const repoName = repo.split('/').pop()
  const hasError = Boolean(data?.baseError || data?.compareError)
  const canStart = !loading && !starting && Boolean(data?.base) && Boolean(data?.compare) && !hasError
  const commitsOpen = (data?.commits.length ?? 0) <= 10

  const run = (fn: () => Promise<void>) => (): void => {
    setStarting(true)
    void fn().finally(() => setStarting(false))
  }

  return (
    <div className="lr-cmp">
      <div className="wf-titlebar">
        <button className="btn btn-sm btn-ghost" onClick={() => backToDashboard()}>
          <I.arrow style={{ width: 12, height: 12, transform: 'rotate(180deg)' }} />repos
        </button>
        <span className="lr-cmp-repo"><b>{repoName}</b> · {repo}</span>
        <span className="grow" />
      </div>

      <div className="lr-cmp-bar">
        <span className="cb-lab">base</span>
        <RefPicker value={baseInput} onChange={setBaseInput} repo={repo} relativeTo={compareInput || 'HEAD'} label="base ref" />
        <span className="cb-arrow">←</span>
        <span className="cb-lab">compare</span>
        <RefPicker value={compareInput} onChange={setCompareInput} repo={repo} relativeTo={compareInput || 'HEAD'} label="compare ref" />
        <button className="lr-cmp-swap" title="Swap base and compare" onClick={() => swapRefs()}>⇄</button>
        <span className="grow" />
        <span className="lr-cmp-summary">
          {data && !hasError
            ? <>{data.commits.length} commits · {data.files.length} files · <span className="add">+{data.add}</span> <span className="del">−{data.del}</span></>
            : loading ? 'computing diff…' : ''}
        </span>
      </div>

      <div className="lr-cmp-context">
        <span className={data?.baseError ? 'ctx-err' : ''}>{data?.baseError ?? data?.base?.context ?? ''}</span>
        <span className={data?.compareError ? 'ctx-err' : ''}>{data?.compareError ?? data?.compare?.context ?? ''}</span>
      </div>

      <div className="lr-cmp-body">
        <div className="lr-cmp-main">
          {loading && <div className="lr-cmp-placeholder">computing diff…</div>}
          {!loading && data && !hasError && (
            <>
              {data.commits.length > 0 && (
                <details className="lr-commits" open={commitsOpen}>
                  <summary>{data.commits.length} commit{data.commits.length === 1 ? '' : 's'}</summary>
                  {data.commits.map((c) => (
                    <div key={c.sha} className="lr-commit">
                      <span className="c-sha">{shortSha(c.sha)}</span>
                      <span className="c-sub">{c.subject}</span>
                      <span className="c-age">{ago(c.date)}</span>
                    </div>
                  ))}
                </details>
              )}
              {data.files.map((f) => <CompareDiff key={f.path} f={f} />)}
              {data.files.length === 0 && <div className="lr-cmp-placeholder">No file changes between these refs.</div>}
            </>
          )}
          {!loading && hasError && <div className="lr-cmp-placeholder">Fix the ref errors above to preview the diff.</div>}
          {!loading && !data && !hasError && <div className="lr-cmp-placeholder">Pick two refs to compare.</div>}
        </div>

        <div className="lr-cmp-side">
          <div className="tweak-sec">Review agent</div>
          <div className="lr-engines">
            {(['claude', 'codex'] as EngineId[]).map((e) => (
              <button key={e} className={'lr-engine' + (engine === e ? ' on' : '')} onClick={() => setEngine(e)}>
                <span className="en-name">
                  <span className={'en-dot ' + (auth[e] ? (auth[e]!.ok ? 'ok' : 'bad') : '')} />
                  {e === 'claude' ? 'Claude' : 'Codex'}
                </span>
                <div className="en-hint">{auth[e]?.hint ?? 'checking…'}</div>
              </button>
            ))}
          </div>

          <div style={{ marginTop: 16 }}>
            {retargetSessionId != null ? (
              <button className="btn btn-primary btn-lg" disabled={!canStart}
                onClick={run(applyRetarget)}>
                Retarget session #{retargetSessionId}
              </button>
            ) : data?.existingSession ? (
              <>
                <button className="btn btn-primary btn-lg" disabled={loading || starting}
                  onClick={run(async () => resumeExisting(data.existingSession!.id))}>
                  Resume review · {data.existingSession.unresolved} unresolved
                </button>
                <button className="btn btn-ghost" style={{ marginTop: 8 }} disabled={starting}
                  onClick={() => {
                    if (window.confirm('Archive the existing review and start a fresh one for this pair?')) {
                      run(async () => startFresh(data.existingSession!.id))()
                    }
                  }}>
                  Start fresh
                </button>
              </>
            ) : (
              <button className="btn btn-primary btn-lg" disabled={!canStart}
                onClick={run(startFromCompare)}>
                Start review<I.chevR style={{ width: 13, height: 13 }} />
              </button>
            )}
          </div>

          {error && <div className="lr-error" style={{ marginTop: 12 }}>{error}</div>}
        </div>
      </div>
    </div>
  )
}
