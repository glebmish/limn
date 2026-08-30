import { describe, it, expect, vi, afterEach } from 'vitest'
import { readDevHooks, readOpenTicket, stripQuery } from '../src/renderer/boot-params'

describe('stripQuery', () => {
  const g = globalThis as unknown as { window?: unknown }
  afterEach(() => { delete g.window })

  function fakeWindow(href: string): ReturnType<typeof vi.fn> {
    const replaceState = vi.fn()
    g.window = { location: { href }, history: { replaceState } }
    return replaceState
  }

  it('drops only the named params and keeps the path, the rest of the query, and the hash', () => {
    const replace = fakeWindow('http://limn.localhost:5466/?open=abc&token=t#x')
    stripQuery(['open'])
    expect(replace).toHaveBeenCalledWith(null, '', '/?token=t#x')
  })
  it('drops the `?` entirely when nothing is left', () => {
    const replace = fakeWindow('http://limn.localhost:5466/?open=abc')
    stripQuery(['open'])
    expect(replace).toHaveBeenCalledWith(null, '', '/')
  })
  it('leaves history alone when none of the params are present', () => {
    const replace = fakeWindow('http://limn.localhost:5466/?token=t')
    stripQuery(['open'])
    expect(replace).not.toHaveBeenCalled()
  })
})

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
