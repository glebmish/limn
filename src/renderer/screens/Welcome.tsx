import { useEffect } from 'react'
import { useStore } from '../store'
import { I } from '../kit'

export default function Welcome() {
  const { recents, error, boot, pickRepo, openRepoPath } = useStore()

  useEffect(() => {
    void boot()
    const dev = window.lrDev
    if (dev?.repo) {
      void openRepoPath(dev.repo).then(() => {
        if (dev.branch) {
          useStore.getState().setBranch(dev.branch)
          void useStore.getState().startReview()
        }
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boot])

  return (
    <>
      <div className="wf-titlebar">
        <span className="wf-title"><b>local-review</b></span>
      </div>
      <div className="lr-center">
        <div className="lr-card">
          <div className="lr-logo">
            <span className="mark"><I.diff style={{ width: 16, height: 16 }} /></span>
            <h1>local-review</h1>
          </div>
          <p className="lr-lede">
            Guided, agentic review of local git branches — before the code leaves your machine.
            Pick a repository to start.
          </p>
          <button className="btn btn-primary btn-lg" onClick={() => void pickRepo()}>
            <I.branch style={{ width: 14, height: 14 }} />Open repository…
          </button>
          {recents.length > 0 && (
            <div className="lr-recents">
              <div className="tweak-sec">Recent</div>
              {recents.map((r) => (
                <button key={r} className="lr-recent" onClick={() => void openRepoPath(r)}>
                  <span className={'ficon fi-md'}></span>
                  <span style={{ minWidth: 0 }}>
                    <div className="name">{r.split('/').pop()}</div>
                    <div className="path">{r}</div>
                  </span>
                </button>
              ))}
            </div>
          )}
          {error && <div className="lr-error">{error}</div>}
        </div>
      </div>
    </>
  )
}
