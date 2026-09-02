import type { OpEventMsg, OpResultMsg, RepoChangedMsg } from '../../shared/ipc'
import { useStore } from './index'
import { anyExclusiveRunning } from './derive'
import { bufferOrphan, takeOrphans } from './orphans'

// Push-event reducers extracted verbatim from App.tsx's useEffect. Each is exactly
// today's guard + dispatch (opId equality, screen/gen.running checks, finishOp →
// conditional reload ordering); App.tsx now only subscribes/unsubscribes these.

export function handleOpEvent(msg: OpEventMsg): void {
  const { opId, event, exclusive, seq } = msg
  // route by opId into the op's own log. An unknown opId is NOT necessarily foreign:
  // it is usually an event racing the load that is about to adopt its op, so park it
  // in the orphan buffer and let adoptOps drain it. A genuinely foreign op (another
  // session's stream) is simply never claimed, and the buffer forgets it.
  const st = useStore.getState()
  if (!st.ops[opId]) { bufferOrphan({ opId, kind: 'event', msg }); return }
  // main announces the lane it actually chose on the event envelope — correct the
  // startOp-time prediction as soon as the first event lands (concurrent-chat OQ7).
  if (exclusive !== undefined) st.setOpLane(opId, exclusive)
  useStore.getState().pushOpEvent(opId, event, seq)
}

export function handleOpResult(msg: OpResultMsg): void {
  const { opId, status, error, reload, errorCode, exclusive } = msg
  const st = useStore.getState()
  const finished = st.ops[opId]
  // same race as an event: the op may finish between the snapshot and the adoption.
  if (!finished) { bufferOrphan({ opId, kind: 'result', msg }); return }
  // terminal lane correction — covers ops that emitted no events before finishing.
  if (exclusive !== undefined) st.setOpLane(opId, exclusive)
  st.finishOp(opId, status, error, errorCode)
  // This thread's turn is over: send whatever the reviewer queued behind it. Any op
  // carrying a threadId counts (a batch/rebase turn ends the thread's busy window too).
  // Deliberately AFTER the reload: reload() replaces the whole chat list, so flushing
  // first would wipe the follow-up's optimistic user message for the entire next turn
  // (main persists the user row several awaits into its own handler). A reload failure
  // still flushes — the turn is what matters, not the refreshed transcript. Only this
  // branch needs it: a flush only ever sends on 'succeeded', which always reloads.
  const { threadId } = finished
  const flush = (): void => { if (threadId != null) useStore.getState().flushQueuedTurn(threadId, status) }
  if (status === 'succeeded' || reload) void st.reload().then(flush, flush)
}

/** Replay everything the buffer parked for `opId`, in arrival order — called by
 *  `adoptOps` right after the op enters the store, so the drained events land behind
 *  the snapshot's replay and `pushOpEvent`'s `seq` check dedupes the overlap. A parked
 *  result therefore applies last, finishing the op exactly as a live one would. */
export function drainOrphans(opId: string): void {
  for (const entry of takeOrphans(opId)) {
    if (entry.kind === 'event') handleOpEvent(entry.msg)
    else handleOpResult(entry.msg)
  }
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
