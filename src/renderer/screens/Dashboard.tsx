import { useEffect, useMemo, useRef } from 'react'
import { useStore } from '../store'
import { I } from '../kit'
import { RepoTree, visiblePinRepos, type FlatRow } from '../components/RepoTree'
import { SessionRow } from '../components/SessionRow'
import type { RecentSession } from '../../shared/types'

export default function Dashboard() {
  const { dashboard, filter, sel, statuses, error, boot, setFilter, pinDirectory, openRepository, unpin, rescan, resumeExisting, enterHub, deleteSession } = useStore()
  const filterRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void boot()
  }, [boot])

  // pinned-dir repos (flat, absPath-keyed) — drive RepoTree highlight + the first
  // run of the keyboard nav. Pure, so StrictMode-safe.
  const flatPins: FlatRow[] = useMemo(() => {
    if (!dashboard) return []
    const out: FlatRow[] = []
    for (const pin of dashboard.pins) {
      if (pin.tree) out.push(...visiblePinRepos(pin.path, pin.tree, filter))
    }
    return out
  }, [dashboard, filter])

  // recent sessions (outside pinned dirs), filtered by repo name / branch / title
  const recentRows: RecentSession[] = useMemo(() => {
    if (!dashboard) return []
    const f = filter.toLowerCase()
    if (!f) return dashboard.recentSessions
    return dashboard.recentSessions.filter((s) => {
      const name = s.repo.split('/').pop() ?? s.repo
      return name.toLowerCase().includes(f) || s.repo.toLowerCase().includes(f)
        || s.compareSymbol.toLowerCase().includes(f) || s.baseSymbol.toLowerCase().includes(f)
        || (s.title?.toLowerCase().includes(f) ?? false)
    })
  }, [dashboard, filter])

  const indexByPath = useMemo(() => new Map(flatPins.map((row, i) => [row.absPath, i] as const)), [flatPins])
  const indexOf = (absPath: string): number => indexByPath.get(absPath) ?? -1   // pins only

  // the keydown effect mounts once — read the current lists through a ref so the
  // handler never closes over stale data. Nav order: pins, then recent sessions.
  const navRef = useRef<{ pins: FlatRow[]; sessions: RecentSession[] }>({ pins: flatPins, sessions: recentRows })
  navRef.current = { pins: flatPins, sessions: recentRows }

  // keyboard: ↑↓ select (works while the filter is focused), ⏎ open,
  // ⌘P pin, Esc clears, plain typing focuses the filter
  useEffect(() => {
    const navLen = (): number => navRef.current.pins.length + navRef.current.sessions.length
    const moveSel = (delta: number): void => {
      const max = Math.max(0, navLen() - 1)
      const next = Math.min(max, Math.max(0, useStore.getState().sel + delta))
      useStore.setState({ sel: next })
    }
    const onKey = (e: KeyboardEvent): void => {
      const active = document.activeElement
      const typing = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
      if (e.key === 'Escape') { setFilter(''); if (filterRef.current) filterRef.current.value = ''; return }
      if (e.key === 'ArrowDown') { e.preventDefault(); moveSel(1); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); moveSel(-1); return }
      if (e.key === 'Enter') {
        e.preventDefault()
        const i = useStore.getState().sel
        const { pins, sessions } = navRef.current
        if (i < pins.length) { const row = pins[i]; if (row) void useStore.getState().openRepo(row.absPath) }
        else { const s = sessions[i - pins.length]; if (s) void useStore.getState().resumeExisting(s.id) }
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'p') { e.preventDefault(); void useStore.getState().pinDirectory(); return }
      if (!typing && e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
        filterRef.current?.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="limn-dash">
      <div className="wf-titlebar">
        <span className="wf-title"><b>limn</b></span>
      </div>

      <div className="limn-dash-head">
        <h1>Repositories</h1>
        <span className="grow" />
        <button className="btn btn-sm btn-primary" onClick={() => void pinDirectory()}>
          <I.plus style={{ width: 12, height: 12 }} />Pin directory…
        </button>
        <button className="btn btn-sm btn-ghost" onClick={() => void openRepository()}>
          <I.branch style={{ width: 12, height: 12 }} />Open repository…
        </button>
      </div>

      <div className="limn-dash-filter">
        <input
          ref={filterRef}
          placeholder="Filter repositories…"
          aria-label="Filter repositories"
          defaultValue={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>

      {error && <div className="limn-error limn-toast">{error}</div>}

      <div className="limn-dash-scroll">
        {!dashboard && <div className="dim" style={{ padding: 20 }}>Loading…</div>}
        {dashboard && dashboard.pins.length === 0 && dashboard.recents.length === 0 && (
          <div className="limn-empty">No repositories yet. <b>Pin a directory</b> to scan it for git repos, or open one directly.</div>
        )}
        {dashboard && dashboard.pins.length === 0 && dashboard.recents.length > 0 && dashboard.recentSessions.length === 0 && (
          <div className="limn-empty">No reviews yet. Use <b>Open repository…</b> to start one.</div>
        )}
        {dashboard?.pins.map((pin) => (
          <div key={pin.id} className="limn-pin">
            <div className="limn-pin-head">
              <span className="pin-path" title={pin.path}>{pin.path}</span>
              <span className="pin-count">· {pin.repoCount} repo{pin.repoCount === 1 ? '' : 's'}</span>
              <span className="grow" />
              <button className="limn-pin-btn" title="Rescan" onClick={() => void rescan(pin.id)}>⟳</button>
              <button className="limn-pin-btn" title="Unpin" onClick={() => void unpin(pin.id)}>✕</button>
            </div>
            {pin.tree
              ? <RepoTree pinPath={pin.path} node={pin.tree} filter={filter} indexOf={indexOf} statuses={statuses} />
              : <div className="dim" style={{ padding: 6 }}>scanning…</div>}
          </div>
        ))}
        {dashboard && recentRows.length > 0 && (
          <div className="limn-recent-sec">
            <div className="rs-h">Recent sessions (outside pinned dirs)</div>
            {recentRows.map((s, i) => (
              <SessionRow key={s.id} s={s} selected={sel === flatPins.length + i}
                repoName={s.repo.split('/').pop()} onRepoClick={() => void enterHub(s.repo)}
                onOpen={() => void resumeExisting(s.id)} onDelete={() => void deleteSession(s.id)} />
            ))}
          </div>
        )}
      </div>

      <div className="limn-foot-hint">↑↓ navigate · ⏎ open · type to filter · ⌘P pin directory</div>
    </div>
  )
}
