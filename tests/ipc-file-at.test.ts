import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/server/db/db'
import { registerIpc } from '../src/server/ipc'
import { resolveRefInput } from '../src/server/git'
import { makeFixtureRepo, fixtureGit } from './helpers/fixtureRepo'
import type { RefSide, FileAt } from '../src/shared/types'
import type { Transport } from '../src/server/transport'

async function setup() {
  const fx = makeFixtureRepo() // `feature` checked out at fx.dir
  const compare = await resolveRefInput(fx.dir, 'feature')
  const side: RefSide = { kind: compare.kind, symbol: compare.symbol, anchorSha: compare.sha }
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'limn-fa-')), 'db')).db
  const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>()
  const transport: Transport = {
    handle(name, fn) { handlers.set(name, fn as (...a: unknown[]) => Promise<unknown>) },
    broadcast() { /* unused */ },
    notify() { /* unused */ },
    async pickDirectory() { return null }
  }
  registerIpc(db, [], transport)
  const read = (s: RefSide, p: string, at: unknown) => handlers.get('readFileAt')!(fx.dir, s, p, at) as Promise<FileAt>
  return { fx, side, read }
}

describe('readFileAt', () => {
  it('reads the worktree file for `now` when the branch is checked out', async () => {
    const { fx, side, read } = await setup()
    fs.writeFileSync(path.join(fx.dir, 'src/a.ts'), 'dirty edit\n')
    expect(await read(side, 'src/a.ts', { kind: 'now' })).toEqual({ ok: true, lines: ['dirty edit'] })
  })

  it('falls back to git show at the compare tip for a branch checked out nowhere', async () => {
    const { fx, read } = await setup()
    fixtureGit(fx.dir, 'checkout', '-q', 'main')
    const feature: RefSide = { kind: 'branch', symbol: 'feature', anchorSha: fx.shas.head }
    const r = await read(feature, 'src/a.ts', { kind: 'now' })
    expect(r).toMatchObject({ ok: true })
    expect((r as { lines: string[] }).lines[1]).toBe('  return 2')
  })

  it('reads a file at a sha', async () => {
    const { fx, side, read } = await setup()
    const r = await read(side, 'src/a.ts', { kind: 'sha', sha: fx.shas.base })
    expect((r as { lines: string[] }).lines[1]).toBe('  return 1')
  })

  it('reports absent, binary, and refuses an option-looking sha', async () => {
    const { fx, side, read } = await setup()
    expect(await read(side, 'src/old.ts', { kind: 'now' })).toEqual({ ok: false, reason: 'absent' })
    expect(await read(side, 'img.bin', { kind: 'sha', sha: fx.shas.base })).toEqual({ ok: false, reason: 'binary' })
    await expect(read(side, 'src/a.ts', { kind: 'sha', sha: '--output=/tmp/x' })).rejects.toThrow(/invalid ref/)
  })
})
