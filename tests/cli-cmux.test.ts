import { describe, it, expect } from 'vitest'
import { cmuxAvailable, openInCmux } from '../src/cli/cmux'

describe('cmuxAvailable', () => {
  it('false without CMUX_SOCKET', () => {
    expect(cmuxAvailable({}, () => true)).toBe(false)
  })
  it('false when cmux is not executable', () => {
    expect(cmuxAvailable({ CMUX_SOCKET: '/tmp/sock' }, () => false)).toBe(false)
  })
  it('true when CMUX_SOCKET is set and cmux is executable', () => {
    expect(cmuxAvailable({ CMUX_SOCKET: '/tmp/sock' }, () => true)).toBe(true)
  })
})

describe('openInCmux', () => {
  it('passes the exact new-pane args', () => {
    const seen: { cmd: string; args: string[] }[] = []
    openInCmux('http://limn.localhost:5466/?open=tkt', (cmd, args) => {
      seen.push({ cmd, args })
      return { status: 0 }
    })
    expect(seen).toEqual([{
      cmd: 'cmux',
      args: ['new-pane', '--type', 'browser', '--direction', 'right', '--url', 'http://limn.localhost:5466/?open=tkt']
    }])
  })
  it('a non-zero exit is a failure with the exit code as the reason', () => {
    expect(openInCmux('http://x', () => ({ status: 1 }))).toEqual({ ok: false, reason: 'exit 1' })
  })
  it('a spawn error is a failure with the error message as the reason', () => {
    expect(openInCmux('http://x', () => ({ status: null, error: new Error('ENOENT') })))
      .toEqual({ ok: false, reason: 'ENOENT' })
  })
  it('a zero exit is success', () => {
    expect(openInCmux('http://x', () => ({ status: 0 }))).toEqual({ ok: true })
  })
})
