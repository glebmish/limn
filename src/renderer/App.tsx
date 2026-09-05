import { useEffect } from 'react'
import { DENSITY, useStore } from './store'
import Dashboard from './screens/Dashboard'
import RepoHub from './screens/RepoHub'
import Review from './screens/Review'
import { SettingsDialog } from './components/SettingsDialog'
import { dev } from './dev'

export default function App() {
  const { screen, settingsOpen, closeSettings } = useStore()

  useEffect(() => {
    const offEvent = window.api.onOpEvent(({ opId, event }) => {
      if (useStore.getState().gen.opId !== opId) return
      useStore.getState().pushOpEvent(event)
    })
    const offResult = window.api.onOpResult(({ opId, status, error, reload, errorCode }) => {
      const st = useStore.getState()
      if (st.gen.opId !== opId) return
      st.finishOp(status, error, errorCode)
      if (status === 'succeeded' || reload) void st.reload()
    })
    const offChanged = window.api.onRepoChanged((msg) => {
      const { repo, branch, drift, writeCapability, watchStopped } = msg
      const st = useStore.getState()
      if (st.screen !== 'review' || st.gen.running) return
      // the branch moved while reading — notify via the titlebar fetch pill instead
      // of yanking the surface out from under the reviewer. They click to fold it in.
      if (st.repo === repo && st.branch === branch) {
        // a stopped watch reports last-known fields, not real drift — reflect the
        // paused state and leave the drift pill as-is; a recovery (no watchStopped)
        // clears the pause and folds the live drift back in.
        st.setWatchStopped(watchStopped ?? null)
        if (!watchStopped) st.setPendingDrift(drift, writeCapability)
        void st.refreshRepoContext()
      }
    })
    const offSettings = window.api.onSettingsOpen(() => useStore.getState().openSettings())
    if (dev.openSettings) useStore.getState().openSettings()
    // CLI: open a repo on Compare (or surface an error on the dashboard).
    // The initial pending open is consumed by store.boot() AFTER the dashboard
    // loads (so its error toast survives loadDashboard's reset) — boot's
    // takeCliOpen also marks the renderer ready. We subscribe here so later
    // second-instance forwards are delivered live.
    const offCli = window.api.onCliOpen((msg) => useStore.getState().applyCliOpen(msg))
    return () => {
      offEvent()
      offResult()
      offChanged()
      offSettings()
      offCli()
    }
  }, [])

  const settings = settingsOpen ? <SettingsDialog onClose={closeSettings} /> : null

  if (screen === 'review') return <><Review />{settings}</>

  return (
    <div className={`wf dz-${DENSITY}`}>
      {screen === 'hub' ? <RepoHub /> : <Dashboard />}
      {settings}
    </div>
  )
}
