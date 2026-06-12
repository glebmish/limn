import { useEffect } from 'react'
import { useStore } from './store'
import Dashboard from './screens/Dashboard'
import Compare from './screens/Compare'
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
    const offChanged = window.api.onRepoChanged(({ repo, branch }) => {
      const st = useStore.getState()
      if (st.screen !== 'review' || st.gen.running) return
      if (st.repo === repo && st.branch === branch) void st.reload()
    })
    // CLI: open a repo on Compare (or surface an error on the dashboard).
    // Subscribe BEFORE takeCliOpen — the main process marks the renderer ready
    // on the first takeCliOpen call and direct-sends from then on.
    const applyCliOpen = (msg: { repo?: string; baseInput?: string; compareInput?: string; error?: string }): void => {
      if (msg.error) { useStore.setState({ error: msg.error }); return }
      if (msg.repo) {
        void useStore.getState().enterCompare(msg.repo, { base: msg.baseInput, compare: msg.compareInput })
      }
    }
    const offCli = window.api.onCliOpen(applyCliOpen)
    void window.api.takeCliOpen().then((msg) => { if (msg) applyCliOpen(msg) })
    return () => {
      offEvent()
      offResult()
      offChanged()
      offCli()
    }
  }, [])

  if (screen === 'review') return <Review />

  const rootStyle = {
    '--accent': accent[0], '--accent-ink': accent[1], '--accent-soft': accent[2], '--accent-line': accent[3]
  } as React.CSSProperties

  return (
    <div className={`wf dz-${density}`} style={rootStyle}>
      {screen === 'compare' ? <Compare /> : <Dashboard />}
    </div>
  )
}
