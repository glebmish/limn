import { describe, it, expect } from 'vitest'
import { runServiceCommand } from '../src/cli/service/index'
import type { Io } from '../src/cli/main'

function fakeIo(): Io & { lines: string[] } {
  const lines: string[] = []
  return { lines, isTTY: false, out: (l) => { lines.push(l) }, err: (l) => { lines.push(l) }, ask: async () => false }
}

/** Run `fn` with process.platform faked — serviceBackend() reads it live. */
async function onPlatform<T>(platform: string, fn: () => Promise<T>): Promise<T> {
  const desc = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  try { return await fn() } finally { Object.defineProperty(process, 'platform', desc) }
}

describe('runServiceCommand on a platform with no backend', () => {
  it('`service logs` says so instead of tailing a launchd log path', async () => {
    const io = fakeIo()
    const code = await onPlatform('win32', () => runServiceCommand({ kind: 'service-logs', follow: false }, io))
    expect(code).toBe(2)
    expect(io.lines.join('\n')).toMatch(/not supported on this platform/)
  })
  it('`service uninstall` and `service install` say so too', async () => {
    const io = fakeIo()
    expect(await onPlatform('win32', () => runServiceCommand({ kind: 'service-uninstall' }, io))).toBe(2)
    expect(await onPlatform('win32', () => runServiceCommand({ kind: 'service-install', port80: false }, io))).toBe(2)
    expect(io.lines.join('\n')).toMatch(/not supported on this platform/)
  })
})
