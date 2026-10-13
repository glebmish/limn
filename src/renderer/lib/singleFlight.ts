/** Run `run` unless one is already in flight. `busy` is a ref, not state, so two
 *  clicks in the same tick (before a re-render could disable the button) still see
 *  it; `setBusy` mirrors it into state for the disabled/readOnly rendering. */
export function singleFlight(busy: { current: boolean }, setBusy: (b: boolean) => void, run: () => Promise<unknown>): Promise<void> {
  if (busy.current) return Promise.resolve()
  busy.current = true
  setBusy(true)
  return run().then(() => {}).finally(() => {
    busy.current = false
    setBusy(false)
  })
}
