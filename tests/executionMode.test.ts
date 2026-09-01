import { describe, it, expect } from 'vitest'
import { DEFAULT_EXECUTION_MODE, EXECUTION_TIERS, isExecutionMode, LEGACY_EXECUTION_MODE } from '../src/shared/executionMode'

describe('EXECUTION_TIERS', () => {
  it('lists the four tiers in ladder order with labels', () => {
    expect(EXECUTION_TIERS.map((t) => t.key)).toEqual(['ask', 'edits', 'auto', 'full'])
    expect(EXECUTION_TIERS.map((t) => t.label)).toEqual([
      'Ask for approval', 'Accept edits', 'Auto mode', 'Full access',
    ])
  })
})

describe('isExecutionMode', () => {
  it('guards valid + invalid values', () => {
    expect(isExecutionMode('ask')).toBe(true)
    expect(isExecutionMode('full')).toBe(true)
    expect(isExecutionMode('nope')).toBe(false)
    expect(isExecutionMode(undefined)).toBe(false)
  })
})

describe('default vs legacy execution mode', () => {
  it('new threads default to auto; pre-column (NULL) threads keep the old ask default', () => {
    expect(DEFAULT_EXECUTION_MODE).toBe('auto')
    expect(LEGACY_EXECUTION_MODE).toBe('ask')
  })
})
