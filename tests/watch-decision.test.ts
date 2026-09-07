import { describe, it, expect } from 'vitest'
import {
  createPollGate, createWatchEpoch, decideWatch, initialWatchDecision, LIVE_INTERVAL_MS, PROBE_INTERVAL_MS, FAILURE_THRESHOLD
} from '../src/server/watch-decision'

const fail = (reason = 'boom') => ({ ok: false as const, reason })
const ok = { ok: true as const }

describe('decideWatch (branch-watcher failure/self-heal state machine)', () => {
  it('starts live: no failures, not stopped', () => {
    expect(initialWatchDecision).toEqual({ failures: 0, stopped: false })
  })

  it('a single failure keeps the watch up (transient tolerance)', () => {
    const d = decideWatch(initialWatchDecision, fail())
    expect(d.next).toEqual({ failures: 1, stopped: false })
    expect(d.emit).toBe('none')
    expect(d.retuneTo).toBeNull()
  })

  it('two consecutive failures still stay up', () => {
    const d = decideWatch({ failures: 1, stopped: false }, fail())
    expect(d.next).toEqual({ failures: 2, stopped: false })
    expect(d.emit).toBe('none')
  })

  it('the 3rd consecutive failure enters stopped, broadcasts reason, retunes to the probe interval', () => {
    const d = decideWatch({ failures: FAILURE_THRESHOLD - 1, stopped: false }, fail('index.lock exists'))
    expect(d.next).toEqual({ failures: FAILURE_THRESHOLD, stopped: true })
    expect(d.emit).toBe('stopped')
    expect(d.reason).toBe('index.lock exists')
    expect(d.retuneTo).toBe(PROBE_INTERVAL_MS)
  })

  it('a success before the 3rd strike resets the counter (any success resets)', () => {
    const d = decideWatch({ failures: 2, stopped: false }, ok)
    expect(d.next).toEqual({ failures: 0, stopped: false })
    expect(d.emit).toBe('none')
    expect(d.retuneTo).toBeNull()
  })

  it('while stopped, a failed probe stays stopped and does not re-broadcast or re-retune', () => {
    const d = decideWatch({ failures: 3, stopped: true }, fail())
    expect(d.next.stopped).toBe(true)
    expect(d.emit).toBe('none')
    expect(d.retuneTo).toBeNull()
  })

  it('the first successful probe self-heals: recovered broadcast, counter reset, live interval restored', () => {
    const d = decideWatch({ failures: 5, stopped: true }, ok)
    expect(d.next).toEqual({ failures: 0, stopped: false })
    expect(d.emit).toBe('recovered')
    expect(d.retuneTo).toBe(LIVE_INTERVAL_MS)
  })
})

// Models the ipc.ts wiring: every stopWatch bumps; startWatch calls stopWatch then
// captures current() at entry, re-checking isCurrent before arming; each poll carries
// its watcher's capture, re-checking isCurrent after its awaits.
describe('createWatchEpoch (watcher lifecycle generation guard)', () => {
  it('a capture stays current until the next bump', () => {
    const e = createWatchEpoch()
    const a = e.current()
    expect(e.isCurrent(a)).toBe(true)
    e.bump()
    expect(e.isCurrent(a)).toBe(false)
  })

  it('overlapping startWatch calls: the earlier arm goes stale, only the later arms', () => {
    const e = createWatchEpoch()
    e.bump(); const a = e.current() // startWatch A: stopWatch bump + capture, then awaits...
    e.bump(); const b = e.current() // startWatch B enters during A's awaits
    expect(e.isCurrent(a)).toBe(false) // A resumes: abandon — its timer is never armed
    expect(e.isCurrent(b)).toBe(true) // B arms — exactly one live watcher
  })

  it('stopWatch during startWatch awaits strands it: no watcher revives after the stop', () => {
    const e = createWatchEpoch()
    e.bump(); const a = e.current() // startWatch A entry, then awaits...
    e.bump() // bare stopWatch (e.g. archiveSession) while A is suspended
    expect(e.isCurrent(a)).toBe(false) // A abandons — zero live watchers
  })

  it('an in-flight poll of a replaced watcher is stale: must not re-arm or broadcast', () => {
    const e = createWatchEpoch()
    e.bump(); const pollEpoch = e.current() // watcher armed; a poll captures its epoch, awaits...
    e.bump(); void e.current() // session switch: stopWatch + a new startWatch arms
    expect(e.isCurrent(pollEpoch)).toBe(false) // old poll resumes mid-retune: dropped
  })

  it('a poll of the still-current watcher proceeds', () => {
    const e = createWatchEpoch()
    e.bump(); const pollEpoch = e.current()
    expect(e.isCurrent(pollEpoch)).toBe(true)
  })
})

// Models the ipc.ts wiring: the 500ms interval fires `poll` regardless of whether the
// previous one finished, so the gate is what keeps one poll's git fan-out from
// stacking on the last one's.
describe('createPollGate (one poll at a time)', () => {
  it('drops a tick that arrives while the previous poll is still in flight', async () => {
    const gate = createPollGate()
    let started = 0
    let release = (): void => {}
    const parked = new Promise<void>((r) => { release = r })
    const slow = async (): Promise<void> => { started++; await parked }

    void gate(slow) // poll 1 — parks mid-git
    await gate(slow) // the next interval tick lands on top of it
    expect(started).toBe(1)

    release()
  })

  it('lets the next tick run once the previous poll settled', async () => {
    const gate = createPollGate()
    let started = 0
    await gate(async () => { started++ })
    await gate(async () => { started++ })
    expect(started).toBe(2)
  })

  it('releases the gate when a poll throws, so the loop is not wedged forever', async () => {
    const gate = createPollGate()
    await expect(gate(async () => { throw new Error('boom') })).rejects.toThrow('boom')
    let ran = false
    await gate(async () => { ran = true })
    expect(ran).toBe(true)
  })
})
