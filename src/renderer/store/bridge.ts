import type { CliOpenMsg, OpEventMsg, OpResultMsg, RepoChangedMsg } from '../../shared/ipc'
import { useStore } from './index'
import { anyExclusiveRunning } from './derive'

// Push-event reducers extracted verbatim from App.tsx's useEffect. Each is exactly
// today's guard + dispatch (opId equality, screen/gen.running checks, finishOp →
// conditional reload ordering); App.tsx now only subscribes/unsubscribes these.

export function handleOpEvent({ opId, event }: OpEventMsg): void {
  // route by opId into the op's own log; unknown opIds (e.g. a second window's op we
  // never started) are dropped, exactly as the single-`gen` demux did.
  if (!useStore.getState().ops[opId]) return
  useStore.getState().pushOpEvent(opId, event)
}

export function handleOpResult({ opId, status, error, reload, errorCode }: OpResultMsg): void {
  const st = useStore.getState()
  if (!st.ops[opId]) return
  st.finishOp(opId, status, error, errorCode)
  if (status === 'succeeded' || reload) void st.reload()
}

export function handleRepoChanged(msg: RepoChangedMsg): void {
  const { repo, branch, drift, writeCapability, watchStopped } = msg
  const st = useStore.getState()
  // ignore drift while an EXCLUSIVE op runs (it moves the tree / owns reload); a
  // read-only shared chat can't move the tree, so let the pill update under it.
  if (st.screen !== 'review' || anyExclusiveRunning(st.ops)) return
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
}

export function handleCliOpen(msg: CliOpenMsg): void {
  useStore.getState().applyCliOpen(msg)
}

export function handleSettingsOpen(): void {
  useStore.getState().openSettings()
}
