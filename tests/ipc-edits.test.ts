import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/server/db/db'
import { registerIpc } from '../src/server/ipc'
import { resolveRefInput } from '../src/server/git'
import { makeFixtureRepo } from './helpers/fixtureRepo'
import type { RefSide } from '../src/shared/types'
import type { Transport } from '../src/server/transport'

async function setup() {
  const { dir } = makeFixtureRepo() // `feature` checked out at dir
  const compare = await resolveRefInput(dir, 'feature')
  const compareSide: RefSide = { kind: compare.kind, symbol: compare.symbol, anchorSha: compare.sha }
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'limn-ed-')), 'db')).db
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()
  const transport: Transport = {
    handle(name, fn) { handlers.set(name, fn as (...a: unknown[]) => Promise<unknown>) },
    broadcast() { /* unused */ },
    notify() { /* unused */ },
    async pickDirectory() { return null }
  }
  registerIpc(db, [], transport)
  return { dir, handlers, compareSide }
}

describe('readWorkingFile / applyEdit handlers', () => {
  it('read → edit → read roundtrip against the compare worktree', async () => {
    const h = await setup()
    const read = await h.handlers.get('readWorkingFile')!(h.dir, h.compareSide, 'src/a.ts') as { ok: true; lines: string[] }
    expect(read.ok).toBe(true)
    expect(read.lines[1]).toBe('  return 2')

    const result = await h.handlers.get('applyEdit')!(h.dir, h.compareSide, 'src/a.ts', {
      start: 2, end: 2, snapshot: ['  return 2'], newLines: ['  return 42 // edited in review']
    }) as { ok: boolean }
    expect(result.ok).toBe(true)
    expect(fs.readFileSync(path.join(h.dir, 'src/a.ts'), 'utf8')).toContain('return 42 // edited in review')
  })

  it('applies a line-count-growing edit through the handler (#10)', async () => {
    const h = await setup()
    const result = await h.handlers.get('applyEdit')!(h.dir, h.compareSide, 'src/a.ts', {
      start: 2, end: 2, snapshot: ['  return 2'], newLines: ['  const n = 2', '  return n']
    }) as { ok: boolean }
    expect(result.ok).toBe(true)
    const after = fs.readFileSync(path.join(h.dir, 'src/a.ts'), 'utf8').split('\n')
    expect(after.slice(0, 4)).toEqual(['export function a() {', '  const n = 2', '  return n', '}'])

    // and the re-read sees the grown file, so the next frame anchors correctly
    const read = await h.handlers.get('readWorkingFile')!(h.dir, h.compareSide, 'src/a.ts') as { ok: true; lines: string[] }
    expect(read.lines[2]).toBe('  return n')
    expect(read.lines.length).toBe(6)
  })

  it('refuses when the compare branch is not checked out anywhere', async () => {
    const h = await setup()
    const main: RefSide = { kind: 'branch', symbol: 'main', anchorSha: 'b'.repeat(40) }
    await expect(h.handlers.get('applyEdit')!(h.dir, main, 'src/a.ts', {
      start: 1, end: 1, snapshot: ['x'], newLines: ['y']
    })).rejects.toThrow(/checked out/)
    await expect(h.handlers.get('readWorkingFile')!(h.dir, main, 'src/a.ts')).rejects.toThrow(/checked out/)
  })
})
