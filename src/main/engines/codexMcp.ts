import http from 'node:http'
import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { LIMN_TOOLS, type AgentToolHost } from './tools.js'

// Codex hosts Limn tools through external MCP servers. The `codex app-server`
// subprocess opens the connection, so we run a localhost streamable-HTTP MCP
// server in main. Each turn registers its AgentToolHost under an unguessable path
// token; app-server approval requests are handled separately in codexAppServer.
// One McpServer + transport per turn, addressed at /mcp/<token>.

interface Turn { server: McpServer; transport: StreamableHTTPServerTransport }
const turns = new Map<string, Turn>()
let httpServer: http.Server | null = null
let listenPort = 0

function ensureServer(): Promise<number> {
  if (httpServer) return Promise.resolve(listenPort)
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => void route(req, res))
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      httpServer = srv
      listenPort = (srv.address() as AddressInfo).port
      resolve(listenPort)
    })
  })
}

async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const token = /^\/mcp\/([^/?]+)/.exec(req.url ?? '')?.[1]
  const turn = token ? turns.get(token) : undefined
  if (!turn) { res.writeHead(404).end('unknown turn'); return }
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  let body: unknown
  if (chunks.length) { try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { /* GET / no body */ } }
  if (process.env.LIMN_MCP_DEBUG) {
    const method = (body as { method?: string } | undefined)?.method
    console.error(`[mcp] ${req.method} ${req.url} → ${method ?? '(no method)'} session=${req.headers['mcp-session-id'] ?? '-'}`)
  }
  await turn.transport.handleRequest(req, res, body)
}

/** Register this turn's tool host and return the URL Codex should be pointed at,
 *  plus a `release` to tear the turn's MCP server down when the turn ends. */
export async function registerCodexTurn(host: AgentToolHost): Promise<{ url: string; release: () => Promise<void> }> {
  const port = await ensureServer()
  const token = randomUUID()
  const server = new McpServer({ name: 'limn', version: '1.0.0' })
  for (const td of LIMN_TOOLS) {
    server.registerTool(td.name, { description: td.description, inputSchema: td.input }, async (args: unknown) => {
      if (process.env.LIMN_MCP_DEBUG) console.error(`[mcp] tool ${td.name} invoked: ${JSON.stringify(args)}`)
      const { result, isError } = await host.call(td.name, args)
      return { content: [{ type: 'text' as const, text: result }], isError }
    })
  }
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), enableJsonResponse: true })
  await server.connect(transport)
  turns.set(token, { server, transport })
  return {
    url: `http://127.0.0.1:${port}/mcp/${token}`,
    release: async () => {
      turns.delete(token)
      await transport.close().catch(() => {})
      await server.close().catch(() => {})
    }
  }
}
