import { describe, it, expect } from 'vitest'
import {
  decideWatch, initialWatchDecision, LIVE_INTERVAL_MS, PROBE_INTERVAL_MS, FAILURE_THRESHOLD
} from '../src/main/watch-decision'

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
