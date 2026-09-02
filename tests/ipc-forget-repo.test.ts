import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openDb } from '../src/server/db/db'
import { registerIpc } from '../src/server/ipc'
import type { Transport } from '../src/server/transport'
import { createSession, listRepoSessions } from '../src/server/db/sessions'
import { makeFixtureRepo } from './helpers/fixtureRepo'
import type { DashboardData } from '../src/shared/ipc'
import type { RefPair } from '../src/shared/types'

function setup(): { db: DatabaseSync; handlers: Map<string, (...args: unknown[]) => unknown> } {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'limn-ipc-')), 'db')).db
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const transport: Transport = {
    handle(name, fn) { handlers.set(name, fn) },
    broadcast() { /* not used */ },
    notify() { /* not used */ },
    async pickDirectory() { return null }
  }
  registerIpc(db, [], transport)
  return { db, handlers }
}

describe('forgetRepo', () => {
  it('drops the repo from the dashboard index and archives its reviews', async () => {
    const { db, handlers } = setup()
    const repo = makeFixtureRepo()
    const pair: RefPair = {
      base: { kind: 'branch', symbol: 'main', anchorSha: repo.shas.base },
      compare: { kind: 'branch', symbol: 'feature', anchorSha: repo.shas.head }
    }
    await handlers.get('openRepo')!(repo.dir)
    const session = createSession(db, repo.dir, pair)
    const before = await handlers.get('dashboard')!() as DashboardData
    expect(before.repos.map((r) => r.path)).toEqual([repo.dir])

    await handlers.get('forgetRepo')!(repo.dir)

    const after = await handlers.get('dashboard')!() as DashboardData
    expect(after.repos).toEqual([])
    expect(after.recents).toEqual([])
    // the review is archived, not deleted — it comes back with the repo
    expect(listRepoSessions(db, repo.dir, true).map((s) => [s.id, s.archived]))
      .toEqual([[session.id, true]])
  })

  it('a forgotten repo returns to the index when it is opened again', async () => {
    const { handlers } = setup()
    const repo = makeFixtureRepo()
    await handlers.get('openRepo')!(repo.dir)
    await handlers.get('forgetRepo')!(repo.dir)

    await handlers.get('openRepo')!(repo.dir)

    const after = await handlers.get('dashboard')!() as DashboardData
    expect(after.repos.map((r) => r.path)).toEqual([repo.dir])
  })
})
