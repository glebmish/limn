import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { main, type Io } from '../src/cli/main'

function fakeIo(): Io & { out_: string[]; err_: string[] } {
  const out_: string[] = [], err_: string[] = []
  return { out_, err_, isTTY: false, out: (l) => { out_.push(l) }, err: (l) => { err_.push(l) }, ask: async () => false }
}

const saved: Record<string, string | undefined> = {}
beforeEach(() => { saved.LIMN_PORT = process.env.LIMN_PORT })
afterEach(() => {
  if (saved.LIMN_PORT === undefined) delete process.env.LIMN_PORT
  else process.env.LIMN_PORT = saved.LIMN_PORT
})

describe('main() dispatch: a CliUsageError thrown by a command (not just by parseArgs)', () => {
  it('an out-of-range LIMN_PORT surfaces as `limn: <message>` and exit 2, not a stack trace, for `service serve`', async () => {
    process.env.LIMN_PORT = '99999'
    const io = fakeIo()
    const code = await main(['service', 'serve'], io)
    expect(code).toBe(2)
    expect(io.err_).toEqual(['limn: --port must be an integer 0-65535, got "99999"'])
  })

  it('same for the `open` path, which resolves its target the same way', async () => {
    process.env.LIMN_PORT = '99999'
    const io = fakeIo()
    const code = await main(['open', '/tmp'], io)
    expect(code).toBe(2)
    expect(io.err_).toEqual(['limn: --port must be an integer 0-65535, got "99999"'])
  })
})
