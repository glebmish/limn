import { useEffect } from 'react'
import { DENSITY, handleOpEvent, handleOpResult, handleRepoChanged, useStore } from './store'
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
    if (dev.openSettings) useStore.getState().openSettings()
    return () => {
      offEvent()
      offResult()
      offChanged()
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
