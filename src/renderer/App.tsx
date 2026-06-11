import { useEffect } from 'react'
import { useStore } from './store'
import Welcome from './screens/Welcome'
import Setup from './screens/Setup'
import Review from './screens/Review'

export default function App() {
  const { screen, density, accent } = useStore()

  useEffect(() => {
    const offEvent = window.api.onOpEvent(({ opId, event }) => {
      if (useStore.getState().gen.opId === opId) useStore.getState().pushOpEvent(event)
    })
    const offResult = window.api.onOpResult(({ opId, ok, error, reload }) => {
      const st = useStore.getState()
      if (st.gen.opId !== opId) return
      st.finishOp(ok ? undefined : error ?? 'unknown error')
      if (ok || reload) void st.reload()
    })
    // watch mode: the branch moved underneath us (e.g. a terminal agent committed)
    const offChanged = window.api.onRepoChanged(({ repo, branch }) => {
      const st = useStore.getState()
      if (st.screen !== 'review' || st.gen.running) return
      if (st.repo === repo && st.branch === branch) void st.reload()
    })
    return () => {
      offEvent()
      offResult()
      offChanged()
    }
  }, [])

  if (screen === 'review') return <Review />

  const rootStyle = {
    '--accent': accent[0], '--accent-ink': accent[1], '--accent-soft': accent[2], '--accent-line': accent[3]
  } as React.CSSProperties

  return (
    <div className={`wf dz-${density}`} style={rootStyle}>
      {screen === 'welcome' ? <Welcome /> : <Setup />}
    </div>
  )
}
