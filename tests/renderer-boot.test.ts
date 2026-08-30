import { describe, it, expect } from 'vitest'
import { readDevHooks, readOpenTicket } from '../src/renderer/boot-params'

describe('boot params', () => {
  it('reads the cli:open ticket from ?open=', () => {
    expect(readOpenTicket('?open=abc123')).toBe('abc123')
    expect(readOpenTicket('?token=t&open=abc123')).toBe('abc123')
    expect(readOpenTicket('')).toBeNull()
  })
  it('parses ?dev= as JSON dev hooks and ignores garbage', () => {
    const hooks = readDevHooks('?dev=' + encodeURIComponent(JSON.stringify({ flow: 'chat', openSession: '7', fakeGen: true })), true)
    expect(hooks).toEqual({ flow: 'chat', openSession: '7', fakeGen: true })
    expect(readDevHooks('?dev=%7Bnot-json', true)).toEqual({})
    expect(readDevHooks('', true)).toEqual({})
  })

  // The hooks run agent prompts and file edits; only the server may arm them
  // (LIMN_DEV_HOOKS=1 → a <meta name="limn-dev"> in the served index.html).
  it('ignores ?dev= entirely when the server did not enable dev hooks', () => {
    const valid = '?dev=' + encodeURIComponent(JSON.stringify({ flow: 'chat', runChat: 'rm -rf /', scenario: '[]' }))
    expect(readDevHooks(valid, false)).toEqual({})
    expect(readDevHooks('?open=t&dev=%7B%7D', false)).toEqual({})
  })
})
