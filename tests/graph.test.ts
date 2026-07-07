import { describe, expect, it } from 'vitest'
import { hasCycle } from '../src/shared/graph'

const e = (from: string, to: string) => ({ from, to })

describe('hasCycle (the one detector main and renderer share)', () => {
  it('a chain is acyclic', () => {
    expect(hasCycle(['a', 'b', 'c'], [e('a', 'b'), e('b', 'c')])).toBe(false)
  })

  it('a back edge is a cycle', () => {
    expect(hasCycle(['a', 'b', 'c'], [e('a', 'b'), e('b', 'c'), e('c', 'a')])).toBe(true)
  })

  it('a self-loop is a cycle', () => {
    expect(hasCycle(['a'], [e('a', 'a')])).toBe(true)
  })

  it('disjoint components are each checked', () => {
    expect(hasCycle(['a', 'b', 'x', 'y'], [e('a', 'b'), e('x', 'y'), e('y', 'x')])).toBe(true)
  })

  it('a diamond (fan-out re-joining) is NOT a cycle', () => {
    expect(hasCycle(['a', 'b', 'c', 'd'], [e('a', 'b'), e('a', 'c'), e('b', 'd'), e('c', 'd')])).toBe(false)
  })

  it('edges naming unknown ids are ignored, not crashed on', () => {
    expect(hasCycle(['a'], [e('ghost', 'a'), e('a', 'ghost')])).toBe(false)
  })
})
