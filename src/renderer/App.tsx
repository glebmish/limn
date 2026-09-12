import { useEffect } from 'react'
import { DENSITY, handleCliOpen, handleOpEvent, handleOpResult, handleRepoChanged, handleSettingsOpen, useStore } from './store'
import Dashboard from './screens/Dashboard'
import RepoHub from './screens/RepoHub'
import Review from './screens/Review'
import { SettingsDialog } from './components/SettingsDialog'
import { dev } from './dev'
import { api } from './lib/api'

export default function App() {
  const { screen, settingsOpen, closeSettings } = useStore()

  useEffect(() => {
    // Subscribe the push-event channels to the named bridge handlers (store/bridge.ts).
    // Each handler carries the exact guard + dispatch this useEffect used to inline.
    const offEvent = api().onOpEvent(handleOpEvent)
    const offResult = api().onOpResult(handleOpResult)
    const offChanged = api().onRepoChanged(handleRepoChanged)
    const offSettings = api().onSettingsOpen(handleSettingsOpen)
    if (dev.openSettings) useStore.getState().openSettings()
    // CLI: open a repo on Compare (or surface an error on the dashboard).
    // The initial pending open is consumed by store.boot() AFTER the dashboard
    // loads (so its error toast survives loadDashboard's reset) — boot's
    // takeCliOpen also marks the renderer ready. We subscribe here so later
    // second-instance forwards are delivered live.
    const offCli = api().onCliOpen(handleCliOpen)
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
