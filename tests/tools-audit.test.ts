import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as git from '../src/server/git'
import * as dao from '../src/server/db/sessions'
import { openDb } from '../src/server/db/db'
import { createSession } from '../src/server/db/sessions'
import { createToolHost, type ToolHostCtx } from '../src/server/engines/tools'
import { makeFixtureRepo } from './helpers/fixtureRepo'
import type { AgentAction } from '../src/shared/types'

function setup(): { ctx: ToolHostCtx; dir: string } {
  const fx = makeFixtureRepo()
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'limn-tools-audit-')), 'db')).db
  const s = createSession(db, fx.dir, {
    base: { kind: 'branch', symbol: 'main', anchorSha: fx.shas.base },
    compare: { kind: 'branch', symbol: 'feature', anchorSha: fx.shas.head }
  }, { engine: 'claude' })
  return {
    dir: fx.dir,
    ctx: {
      db, sessionId: s.id, threadId: 1, opId: 'o', repo: fx.dir,
      agent: { engine: 'claude' }, emit: () => {}
    }
  }
}

describe('point — the walkthrough resolves its tree facts once, not once per stop', () => {
  it('stamps three diff stops with one session load, one headSha and one mergeBase', async () => {
    const { ctx } = setup()
    const host = createToolHost(ctx)
    const getSession = vi.spyOn(dao, 'getSession')
    const head = vi.spyOn(git, 'headSha')
    const mergeBase = vi.spyOn(git, 'mergeBase')
    let action: AgentAction | undefined
    try {
      ;({ action } = await host.call('point', {
        stops: [
          { target: { kind: 'diff', file: 'src/a.ts', side: 'new', line: 1 } },
          { target: { kind: 'diff', file: 'src/a.ts', side: 'new', line: 2 } },
          { target: { kind: 'diff', file: 'src/b.ts', side: 'new', line: 2 } }
        ]
      }))
      // head/mergeBase cannot differ between stops of one call — the walkthrough
      // must not pay for the same triple three times.
      expect(getSession).toHaveBeenCalledTimes(1)
      expect(head).toHaveBeenCalledTimes(1)
      expect(mergeBase).toHaveBeenCalledTimes(1)
    } finally {
      getSession.mockRestore()
      head.mockRestore()
      mergeBase.mockRestore()
    }
    // …and every stop is still stamped exactly as before
    const stops = (action as Extract<AgentAction, { kind: 'point' }>).stops
    for (const s of stops) expect(s.target.kind === 'diff' && s.target.stamp?.headSha).toBeTruthy()
    expect(stops[1].target.kind === 'diff' && stops[1].target.lineContent).toBe('  return 2')
  })

  it('does not touch the DB or git for a walkthrough with no diff stop', async () => {
    const { ctx } = setup()
    const host = createToolHost(ctx)
    const getSession = vi.spyOn(dao, 'getSession')
    const head = vi.spyOn(git, 'headSha')
    try {
      const { action } = await host.call('point', {
        stops: [{ target: { kind: 'summary' } }, { target: { kind: 'section', sectionId: 's1' } }]
      })
      expect(getSession).not.toHaveBeenCalled()
      expect(head).not.toHaveBeenCalled()
      expect(action?.kind === 'point' && action.stops).toHaveLength(2)
    } finally {
      getSession.mockRestore()
      head.mockRestore()
    }
  })
})
