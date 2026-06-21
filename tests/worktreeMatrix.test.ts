import { describe, it, expect } from 'vitest'
import { checkoutMatrix, type WtState } from '../src/renderer/lib/worktreeMatrix'

const primary: WtState = { path: '/repo', branch: 'main', primary: true, dirty: false }
const linked: WtState = { path: '/repo--feat', branch: 'feat', primary: false, dirty: false }
const dirtyLinked: WtState = { path: '/repo--wip', branch: null, primary: false, dirty: true }

describe('checkoutMatrix', () => {
  it('homeless branch + clean target → checkout, not blocked', () => {
    const wts = [primary, dirtyLinked]
    const m = checkoutMatrix('feat', true, wts, '/repo')
    expect(m).toEqual({ mode: 'checkout', target: primary, dirtyBlocked: false })
  })

  it('homeless branch + dirty target → checkout, blocked', () => {
    const wts = [primary, dirtyLinked]
    const m = checkoutMatrix('feat', true, wts, '/repo--wip')
    expect(m).toEqual({ mode: 'checkout', target: dirtyLinked, dirtyBlocked: true })
  })

  it('homeless branch + unknown target → falls back to first worktree', () => {
    const m = checkoutMatrix('feat', true, [primary, dirtyLinked], '/does-not-exist')
    expect(m).toEqual({ mode: 'checkout', target: primary, dirtyBlocked: false })
  })

  it('branch checked out in the selected target → settled', () => {
    const m = checkoutMatrix('feat', true, [primary, linked], '/repo--feat')
    expect(m).toEqual({ mode: 'settled', host: linked })
  })

  it('branch checked out in another worktree → goto-host', () => {
    const m = checkoutMatrix('feat', true, [primary, linked], '/repo')
    expect(m).toEqual({ mode: 'goto-host', host: linked })
  })

  it('non-branch ref (commit/HEAD~N) → not-a-branch', () => {
    const m = checkoutMatrix('a1b2c3d', false, [primary, linked], '/repo')
    expect(m).toEqual({ mode: 'not-a-branch' })
  })
})
