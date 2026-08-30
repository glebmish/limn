import { describe, it, expect } from 'vitest'
import { readDevHooks, readOpenTicket } from '../src/renderer/boot-params'

describe('boot params', () => {
  it('reads the cli:open ticket from ?open=', () => {
    expect(readOpenTicket('?open=abc123')).toBe('abc123')
    expect(readOpenTicket('?token=t&open=abc123')).toBe('abc123')
    expect(readOpenTicket('')).toBeNull()
  })
  it('parses ?dev= as JSON dev hooks and ignores garbage', () => {
    const hooks = readDevHooks('?dev=' + encodeURIComponent(JSON.stringify({ flow: 'chat', openSession: '7', fakeGen: true })))
    expect(hooks).toEqual({ flow: 'chat', openSession: '7', fakeGen: true })
    expect(readDevHooks('?dev=%7Bnot-json')).toEqual({})
    expect(readDevHooks('')).toEqual({})
  })
})
