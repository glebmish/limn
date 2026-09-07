import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { codexBinaryPath, engineBinaryStatus, probeEngineVersion, setEngineBinaryPrefs, setVersionSpawnForTests } from '../src/server/engines/binaries'
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
  setVersionSpawnForTests(undefined)
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

  it('resolves a PATH entry that is a symlink to an executable file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limn-bin-'))
    const real = executable(dir, 'codex-real')
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'limn-bin-'))
    const link = path.join(binDir, 'codex')
    fs.symlinkSync(real, link)
    process.env.PATH = binDir

    expect(codexBinaryPath()).toBe(link)
    expect(engineBinaryStatus('codex')).toMatchObject({ source: 'path', ok: true, path: link })
  })

  it('does not accept a PATH entry that is a symlink to a directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limn-bin-'))
    const target = path.join(dir, 'codex-dir')
    fs.mkdirSync(target)
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'limn-bin-'))
    fs.symlinkSync(target, path.join(binDir, 'codex'))
    process.env.PATH = binDir

    expect(codexBinaryPath()).toBeUndefined()
    expect(engineBinaryStatus('codex')).toMatchObject({ configured: false, source: 'missing', ok: false })
  })

  it('rejects a configured path that is a symlink to a directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limn-bin-'))
    const target = path.join(dir, 'codex-dir')
    fs.mkdirSync(target)
    const link = path.join(dir, 'codex-link')
    fs.symlinkSync(target, link)
    process.env.PATH = ''

    setEngineBinaryPrefs({ [ENGINE_PATH_PREF_KEYS.codex]: link })

    expect(engineBinaryStatus('codex')).toMatchObject({
      configured: true,
      source: 'configured',
      ok: false,
      hint: 'Configured path is not a file.'
    })
  })

  it('accepts a configured path that is a symlink to an executable file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limn-bin-'))
    const real = executable(dir, 'codex-real')
    const link = path.join(dir, 'codex-link')
    fs.symlinkSync(real, link)
    process.env.PATH = ''

    setEngineBinaryPrefs({ [ENGINE_PATH_PREF_KEYS.codex]: link })

    expect(engineBinaryStatus('codex')).toMatchObject({ configured: true, ok: true, path: link })
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

describe('probeEngineVersion', () => {
  function onPath(name: string): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'limn-ver-'))
    executable(dir, name)
    process.env.PATH = dir
  }

  it('parses the first semver from --version output', async () => {
    onPath('codex')
    setVersionSpawnForTests(async () => 'codex-cli 0.200.0\n')
    expect(await probeEngineVersion('codex')).toEqual({ version: '0.200.0' })
  })

  it('parses a semver embedded in claude output', async () => {
    onPath('claude')
    setVersionSpawnForTests(async () => '1.2.3 (Claude Code)\n')
    expect(await probeEngineVersion('claude')).toEqual({ version: '1.2.3' })
  })

  it('returns {} for garbage output', async () => {
    onPath('codex')
    setVersionSpawnForTests(async () => 'no version here')
    expect(await probeEngineVersion('codex')).toEqual({})
  })

  it('returns {} for empty output', async () => {
    onPath('codex')
    setVersionSpawnForTests(async () => '')
    expect(await probeEngineVersion('codex')).toEqual({})
  })

  it('warns when codex is below the known-good floor', async () => {
    onPath('codex')
    setVersionSpawnForTests(async () => 'codex-cli 0.98.0')
    const info = await probeEngineVersion('codex')
    expect(info.version).toBe('0.98.0')
    expect(info.warning).toBeDefined()
    expect(info.warning).toContain('0.98.0')
    expect(info.warning).toContain('0.135.0')
  })

  it('does not warn when codex is exactly at the floor', async () => {
    onPath('codex')
    setVersionSpawnForTests(async () => 'codex-cli 0.135.0')
    expect(await probeEngineVersion('codex')).toEqual({ version: '0.135.0' })
  })

  it('does not warn when codex is above the floor', async () => {
    onPath('codex')
    setVersionSpawnForTests(async () => 'codex-cli 1.0.0')
    expect(await probeEngineVersion('codex')).toEqual({ version: '1.0.0' })
  })

  it('never warns for claude even on an old version, but still reports it', async () => {
    onPath('claude')
    setVersionSpawnForTests(async () => '0.0.1 (Claude Code)')
    expect(await probeEngineVersion('claude')).toEqual({ version: '0.0.1' })
  })

  it('returns {} when the spawn fails', async () => {
    onPath('codex')
    setVersionSpawnForTests(async () => { throw new Error('spawn ENOENT') })
    expect(await probeEngineVersion('codex')).toEqual({})
  })

  it('returns {} when the binary cannot be resolved', async () => {
    process.env.PATH = ''
    setEngineBinaryPrefs({})
    expect(await probeEngineVersion('codex')).toEqual({})
  })

  it('caches per resolved path and does not respawn', async () => {
    onPath('codex')
    let calls = 0
    setVersionSpawnForTests(async () => { calls++; return 'codex-cli 1.0.0' })
    await probeEngineVersion('codex')
    await probeEngineVersion('codex')
    expect(calls).toBe(1)
  })
})
