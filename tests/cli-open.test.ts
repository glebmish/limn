import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import { issueCliOpen, takeCliOpen, _resetTickets } from '../src/main/cliOpen'
import { makeFixtureRepo } from './helpers/fixtureRepo'

describe('cli:open tickets', () => {
  it('issues a ticket whose message resolves the repo root and carries the refs', async () => {
    _resetTickets()
    const fx = makeFixtureRepo()
    const { ticket } = await issueCliOpen({ dir: fx.dir, base: 'main', compare: 'feature', hub: false, fresh: true })
    expect(ticket).toMatch(/^[0-9a-f]{32}$/)
    // repoRoot returns git's realpath (/private/var vs /var on macOS)
    expect(takeCliOpen(ticket)).toEqual({ repo: fs.realpathSync(fx.dir), baseInput: 'main', compareInput: 'feature', hub: false, fresh: true })
  })
  it('a ticket is single-use', async () => {
    _resetTickets()
    const fx = makeFixtureRepo()
    const { ticket } = await issueCliOpen({ dir: fx.dir })
    expect(takeCliOpen(ticket)).not.toBeNull()
    expect(takeCliOpen(ticket)).toBeNull()
  })
  it('a non-git dir yields an error message the UI can show', async () => {
    _resetTickets()
    const { ticket } = await issueCliOpen({ dir: '/' })
    expect(takeCliOpen(ticket)).toEqual({ error: '/ is not inside a git repository' })
  })
  it('unknown / expired tickets are null', () => {
    _resetTickets()
    expect(takeCliOpen('nope')).toBeNull()
  })
})
