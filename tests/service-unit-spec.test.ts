import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { unitSpec } from '../src/cli/service/index'

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

  it('records a real node binary and passes port80 through', () => {
    const spec = unitSpec(true, { loginPath: LOGIN_PATH })
    expect(path.isAbsolute(spec.nodePath)).toBe(true)
    expect(fs.statSync(spec.nodePath).isFile()).toBe(true)
    expect(spec.port80).toBe(true)
    expect(unitSpec(false, { loginPath: LOGIN_PATH }).port80).toBe(false)
  })
})
