import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { codexBinaryPath, engineBinaryStatus, setEngineBinaryPrefs } from '../src/main/engines/binaries'
import { ENGINE_PATH_PREF_KEYS } from '../src/shared/prefs'

const originalPath = process.env.PATH

function executable(dir: string, name: string): string {
  const file = path.join(dir, name)
  fs.writeFileSync(file, '#!/bin/sh\nexit 0\n')
  fs.chmodSync(file, 0o755)
  return file
}

afterEach(() => {
  process.env.PATH = originalPath
  setEngineBinaryPrefs({})
})

describe('engine binary preferences', () => {
  it('uses a configured executable path before PATH', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limn-bin-'))
    const configured = executable(dir, 'codex-custom')
    process.env.PATH = ''

    setEngineBinaryPrefs({ [ENGINE_PATH_PREF_KEYS.codex]: configured })

    expect(codexBinaryPath()).toBe(configured)
    expect(engineBinaryStatus('codex')).toMatchObject({
      configured: true,
      source: 'configured',
      ok: true,
      path: configured
    })
  })

  it('falls back to PATH when the configured value is blank', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limn-bin-'))
    const discovered = executable(dir, 'codex')
    process.env.PATH = dir

    setEngineBinaryPrefs({ [ENGINE_PATH_PREF_KEYS.codex]: '   ' })

    expect(codexBinaryPath()).toBe(discovered)
    expect(engineBinaryStatus('codex')).toMatchObject({
      configured: false,
      source: 'path',
      ok: true,
      path: discovered
    })
  })

  it('does not silently ignore an invalid configured path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limn-bin-'))
    executable(dir, 'codex')
    process.env.PATH = dir
    const missing = path.join(dir, 'missing-codex')

    setEngineBinaryPrefs({ [ENGINE_PATH_PREF_KEYS.codex]: missing })

    expect(codexBinaryPath()).toBe(missing)
    expect(engineBinaryStatus('codex')).toMatchObject({
      configured: true,
      source: 'configured',
      ok: false,
      path: missing
    })
  })
})
