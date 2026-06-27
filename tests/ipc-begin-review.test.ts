import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/main/db/db'
import { createSession, listChatThreads } from '../src/main/db/sessions'
import { registerIpc } from '../src/main/ipc'
import type { AgentRef, RefPair } from '../src/shared/types'
import type { Transport } from '../src/main/transport'

const pair: RefPair = {
  base: { kind: 'branch', symbol: 'main', anchorSha: 'a'.repeat(40) },
  compare: { kind: 'branch', symbol: 'feature', anchorSha: 'b'.repeat(40) }
}
const agent: AgentRef = { engine: 'codex', model: 'gpt-5.5', reasoningEffort: 'low' }

function setup(): {
  db: ReturnType<typeof openDb>['db']
  handlers: Map<string, (...args: unknown[]) => unknown>
  sessionId: number
} {
  const db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'limn-ipc-')), 'db')).db
  const sessionId = createSession(db, '/repo', pair, agent).id
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const transport: Transport = {
    handle(name, fn) { handlers.set(name, fn) },
    broadcast() { /* not used */ },
    notify() { /* not used */ },
    async pickDirectory() { return null }
  }
  registerIpc(db, [], transport)
  return { db, handlers, sessionId }
}

describe('beginReview', () => {
  it('reuses the latest review thread for update runs', async () => {
    const { db, handlers, sessionId } = setup()
    const beginReview = handlers.get('beginReview')!

    const first = await beginReview(sessionId, agent) as number
    const update = await beginReview(sessionId, agent, true, 'focus on server guard') as number

    expect(update).toBe(first)
    const reviews = listChatThreads(db, sessionId).filter((t) => t.kind === 'review')
    expect(reviews).toHaveLength(1)
    expect(reviews[0].messages.map((m) => m.text)).toEqual([
      'Generate a guided review of feature against main.',
      'Update a guided review of feature against main.\n\nReviewer steer: focus on server guard'
    ])
  })

  it('starts a new review thread for non-update regeneration', async () => {
    const { db, handlers, sessionId } = setup()
    const beginReview = handlers.get('beginReview')!

    const first = await beginReview(sessionId, agent) as number
    const second = await beginReview(sessionId, agent, false) as number

    expect(second).not.toBe(first)
    expect(listChatThreads(db, sessionId).filter((t) => t.kind === 'review')).toHaveLength(2)
  })
})
