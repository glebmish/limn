import { useEffect, useMemo, useRef } from 'react'
import { useStore } from '../store'
import { I } from '../kit'
import { RepoTree, visiblePinRepos, type FlatRow } from '../components/RepoTree'

export default function Dashboard() {
  const { dashboard, filter, sel, statuses, error, boot, setFilter, pinDirectory, openRepository, unpin, rescan, enterCompare } = useStore()
  const filterRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void boot()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boot])

  // the flattened visible repo rows (pins in order, then recents) — pure, so it
  // is StrictMode-safe; recomputed only when the data or the filter changes
  const flat: FlatRow[] = useMemo(() => {
    if (!dashboard) return []
    const out: FlatRow[] = []
    for (const pin of dashboard.pins) {
      if (pin.tree) out.push(...visiblePinRepos(pin.path, pin.tree, filter))
    }
    const f = filter.toLowerCase()
    for (const r of dashboard.recents) {
      const name = r.split('/').pop() ?? r
      if (!f || name.toLowerCase().includes(f) || r.toLowerCase().includes(f)) {
        out.push({ absPath: r, node: { name, relPath: '', kind: 'repo', children: [] }, pinPath: r })
      }
    }
    return out
  }, [dashboard, filter])

  const indexByPath = useMemo(() => new Map(flat.map((row, i) => [row.absPath, i] as const)), [flat])
  const indexOf = (absPath: string): number => indexByPath.get(absPath) ?? -1

  // the keydown effect mounts once — read the current list through a ref so
  // the handler never closes over a stale flat
  const flatRef = useRef<FlatRow[]>(flat)
  flatRef.current = flat

  // keyboard: ↑↓ select (works while the filter is focused), ⏎ open,
  // ⌘P pin, Esc clears, plain typing focuses the filter
  useEffect(() => {
    const moveSel = (delta: number): void => {
      const max = Math.max(0, flatRef.current.length - 1)
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
        const row = flatRef.current[useStore.getState().sel]
        if (row) void useStore.getState().enterCompare(row.absPath)
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
    <div className="lr-dash">
      <div className="wf-titlebar">
        <span className="wf-title"><b>local-review</b></span>
      </div>

      <div className="lr-dash-head">
        <h1>Repositories</h1>
        <span className="grow" />
        <button className="btn btn-sm btn-primary" onClick={() => void pinDirectory()}>
          <I.plus style={{ width: 12, height: 12 }} />Pin directory…
        </button>
        <button className="btn btn-sm btn-ghost" onClick={() => void openRepository()}>
          <I.branch style={{ width: 12, height: 12 }} />Open repository…
        </button>
      </div>

      <div className="lr-dash-filter">
        <input
          ref={filterRef}
          placeholder="Filter repositories…"
          aria-label="Filter repositories"
          defaultValue={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>

      {error && <div className="lr-error lr-toast">{error}</div>}

      <div className="lr-dash-scroll">
        {!dashboard && <div className="dim" style={{ padding: 20 }}>Loading…</div>}
        {dashboard && dashboard.pins.length === 0 && dashboard.recents.length === 0 && (
          <div className="lr-empty">No repositories yet. <b>Pin a directory</b> to scan it for git repos, or open one directly.</div>
        )}
        {dashboard?.pins.map((pin) => (
          <div key={pin.id} className="lr-pin">
            <div className="lr-pin-head">
              <span className="pin-path">{pin.path}</span>
              <span className="pin-count">· {pin.repoCount} repo{pin.repoCount === 1 ? '' : 's'}</span>
              <span className="grow" />
              <button className="lr-pin-btn" title="Rescan" onClick={() => void rescan(pin.id)}>⟳</button>
              <button className="lr-pin-btn" title="Unpin" onClick={() => void unpin(pin.id)}>✕</button>
            </div>
            {pin.tree
              ? <RepoTree pinPath={pin.path} node={pin.tree} filter={filter} indexOf={indexOf} statuses={statuses} />
              : <div className="dim" style={{ padding: 6 }}>scanning…</div>}
          </div>
        ))}
        {dashboard && dashboard.recents.some((r) => indexOf(r) >= 0) && (
          <div className="lr-recent-sec">
            <div className="rs-h">Recent (outside pinned dirs)</div>
            {dashboard.recents.map((r) => {
              const idx = indexOf(r)
              if (idx < 0) return null // filtered out
              const st = statuses[r]
              return (
                <div key={r} className={'lr-row' + (sel === idx ? ' sel' : '')} onClick={() => void enterCompare(r)}>
                  <span className="r-name">{r.split('/').pop()}</span>
                  <span className="r-parent">{r}</span>
                  <span className="grow" />
                  <span className="lr-chip">{st ? st.branch : '…'}</span>
                  <span className={'lr-dirty ' + (st ? (st.dirty ? 'on' : 'off') : 'off')} />
                </div>
              )
            })}
          </div>
        )}
      </div>

      <div className="lr-foot-hint">↑↓ navigate · ⏎ open · type to filter · ⌘P pin directory</div>
    </div>
  )
}
