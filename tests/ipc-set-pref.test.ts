import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/server/db/db'
import { registerIpc } from '../src/server/ipc'
import type { Transport } from '../src/server/transport'

function setup(): { handlers: Map<string, (...args: unknown[]) => unknown> } {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'limn-ipc-')), 'db')).db
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const transport: Transport = {
    handle(name, fn) { handlers.set(name, fn) },
    broadcast() { /* not used */ },
    notify() { /* not used */ },
    async pickDirectory() { return null }
  }
  registerIpc(db, [], transport)
  return { handlers }
}

describe('setPref: defaultAgent enforcement', () => {
  it('stores a valid defaultAgent, readable via getPrefs', async () => {
    const { handlers } = setup()
    const setPref = handlers.get('setPref')!
    const getPrefs = handlers.get('getPrefs')!

    await setPref('defaultAgent', '{"engine":"codex"}')

    const prefs = await getPrefs() as Record<string, string>
    expect(prefs.defaultAgent).toBe('{"engine":"codex"}')
  })

  it('rejects an unknown engine and stores nothing', async () => {
    const { handlers } = setup()
    const setPref = handlers.get('setPref')!
    const getPrefs = handlers.get('getPrefs')!

    await expect(setPref('defaultAgent', '{"engine":"nope"}'))
      .rejects.toThrow('unknown engine "nope" (claude, codex)')

    const prefs = await getPrefs() as Record<string, string>
    expect(prefs.defaultAgent).toBeUndefined()
  })

  it('rejects invalid JSON and stores nothing', async () => {
    const { handlers } = setup()
    const setPref = handlers.get('setPref')!
    const getPrefs = handlers.get('getPrefs')!

    await expect(setPref('defaultAgent', 'not json')).rejects.toThrow()

    const prefs = await getPrefs() as Record<string, string>
    expect(prefs.defaultAgent).toBeUndefined()
  })

  it('leaves other pref keys unvalidated', async () => {
    const { handlers } = setup()
    const setPref = handlers.get('setPref')!
    const getPrefs = handlers.get('getPrefs')!

    await setPref('sidebarView', '"tree"')

    const prefs = await getPrefs() as Record<string, string>
    expect(prefs.sidebarView).toBe('"tree"')
  })
})
