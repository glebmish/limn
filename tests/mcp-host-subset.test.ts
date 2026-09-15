import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { registerTurn } from '../src/server/engines/mcpHost'
import { createToolHost, toolsForTurn, type ToolHostCtx } from '../src/server/engines/tools'

// The MCP host must serve exactly the turn's subset: an action run's agent cannot
// even see add_comment, so the "post as a comment" reflex a review skill carries has
// nothing to call.
const releases: (() => Promise<void>)[] = []
afterEach(async () => { for (const r of releases.splice(0)) await r() })

function host(tools: ToolHostCtx['tools']) {
  return createToolHost({ db: null as never, sessionId: 1, threadId: 1, opId: 'op', repo: '/tmp/r', agent: { engine: 'claude' }, emit: () => {}, ...(tools ? { tools } : {}) })
}

async function listNames(url: string): Promise<string[]> {
  const client = new Client({ name: 'test', version: '0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(url)))
  try { return (await client.listTools()).tools.map((t) => t.name).sort() } finally { await client.close() }
}

describe('registerTurn serves the host\'s subset', () => {
  it('an action-run host lists only the read-only trio', async () => {
    const { url, release } = await registerTurn(host(toolsForTurn('action')))
    releases.push(release)
    expect(await listNames(url)).toEqual(['get_review', 'get_review_progress', 'list_comments'])
  })
  it('a chat host lists the whole catalog', async () => {
    const { url, release } = await registerTurn(host(undefined))
    releases.push(release)
    expect((await listNames(url)).length).toBe(11)
  })
})
