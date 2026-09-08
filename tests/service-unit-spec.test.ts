import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { unitSpec } from '../src/cli/service/index'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execSync: vi.fn(actual.execSync) }
})

const FORWARDED = ['LIMN_PORT', 'LIMN_DB', 'LIMN_WEB_HOST', 'LIMN_WEB_TOKEN']
const saved: Record<string, string | undefined> = {}
// A fixed PATH keeps the assertions independent of whatever the login shell exports.
const LOGIN_PATH = '/usr/bin:/bin:/usr/bin:/opt/homebrew/bin'

beforeEach(() => {
  for (const k of FORWARDED) { saved[k] = process.env[k]; delete process.env[k] }
})
afterEach(() => {
  for (const k of FORWARDED) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
})

describe('unitSpec', () => {
  it('forwards exactly the LIMN_* vars the installing shell set', () => {
    process.env.LIMN_PORT = '5477'
    process.env.LIMN_DB = '/tmp/x.db'
    process.env.LIMN_WEB_TOKEN = 'abc'
    expect(unitSpec(false, { loginPath: LOGIN_PATH }).extraEnv)
      .toEqual({ LIMN_PORT: '5477', LIMN_DB: '/tmp/x.db', LIMN_WEB_TOKEN: 'abc' })
  })

  it('forwards nothing when none are set', () => {
    expect(unitSpec(false, { loginPath: LOGIN_PATH }).extraEnv).toEqual({})
  })

  it('puts the unit node first on PATH and de-duplicates the rest', () => {
    const spec = unitSpec(false, { loginPath: LOGIN_PATH })
    const segments = spec.pathEnv.split(path.delimiter)
    expect(segments[0]).toBe(path.dirname(spec.nodePath))
    expect(new Set(segments).size).toBe(segments.length)
    expect(segments).toContain('/opt/homebrew/bin')
  })

  // Under `tsx src/cli/index.ts service install` there is no built sibling, and the
  // argv[1] fallback would record a .ts entry that plain node cannot start.
  it('refuses to record a TypeScript entry script', () => {
    const savedArgv1 = process.argv[1]
    process.argv[1] = path.resolve('src/cli/index.ts')
    try {
      expect(() => unitSpec(false, { loginPath: LOGIN_PATH })).toThrow(/npm run build/)
    } finally { process.argv[1] = savedArgv1 }
  })

  it('isolates the PATH from login-shell startup chatter (nvm/oh-my-zsh banners) instead of baking it in verbatim', () => {
    // The banner precedes the sentinel-bracketed PATH, exactly as a real
    // `$SHELL -ilc 'echo START; echo -n "$PATH"; echo; echo END'` capture would.
    const raw = 'Now using node v20.11.0 (npm v10.2.4)\n__LIMN_PATH_START__\n/usr/local/bin:/usr/bin:/bin\n__LIMN_PATH_END__\n'
    vi.mocked(execSync).mockReturnValueOnce(raw)
    const spec = unitSpec(false)
    const segments = spec.pathEnv.split(path.delimiter)
    expect(segments).toContain('/usr/local/bin')
    expect(segments.every((s) => path.isAbsolute(s))).toBe(true)
  })

  it('falls back to process.env.PATH when the captured output has no markers or does not look like a PATH', () => {
    const savedPath = process.env.PATH
    process.env.PATH = '/env/bin:/env/usr/bin'
    try {
      vi.mocked(execSync).mockReturnValueOnce('no markers here, just a startup banner\n')
      expect(unitSpec(false).pathEnv.split(path.delimiter)).toContain('/env/bin')
      vi.mocked(execSync).mockReturnValueOnce('__LIMN_PATH_START__\nnot a path\n__LIMN_PATH_END__\n')
      expect(unitSpec(false).pathEnv.split(path.delimiter)).toContain('/env/bin')
    } finally {
      if (savedPath === undefined) delete process.env.PATH
      else process.env.PATH = savedPath
    }
  })

  it('records a real node binary and passes port80 through', () => {
    const spec = unitSpec(true, { loginPath: LOGIN_PATH })
    expect(path.isAbsolute(spec.nodePath)).toBe(true)
    expect(fs.statSync(spec.nodePath).isFile()).toBe(true)
    expect(spec.port80).toBe(true)
    expect(unitSpec(false, { loginPath: LOGIN_PATH }).port80).toBe(false)
  })
})
