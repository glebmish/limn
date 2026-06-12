import { describe, it, expect } from 'vitest'
import { refIdentity, effectiveRef, type RefSide } from '../src/shared/types'

describe('ref pair identity', () => {
  const branchSide: RefSide = { kind: 'branch', symbol: 'feature/x', anchorSha: 'aaa111' }
  const commitSide: RefSide = { kind: 'commit', symbol: 'HEAD~3', anchorSha: 'bbb222' }

  it('branch identity keys by name, commit identity by sha', () => {
    expect(refIdentity(branchSide)).toBe('b:feature/x')
    expect(refIdentity(commitSide)).toBe('c:bbb222')
  })

  it('effectiveRef: branches stay live (name), commits freeze (sha)', () => {
    expect(effectiveRef(branchSide)).toBe('feature/x')
    expect(effectiveRef(commitSide)).toBe('bbb222')
  })
})
