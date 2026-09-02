import type { DatabaseSync } from 'node:sqlite'
import { defaultDbPath } from '../server/paths.js'
import { probeHealth, type HealthInfo } from './health.js'
import { serviceTarget, type ServiceTarget } from './target.js'
import { rpc } from './rpc.js'
import { validateAgentRefJson } from '../shared/agents.js'
import { resolveDefaultAgent, DEFAULT_AGENT_PREF_KEY } from '../shared/prefs.js'
import { applyConfigChange, formatConfig, type ConfigKey } from '../shared/agentConfig.js'
import type { AgentRef } from '../shared/types.js'
import type { ConfigCommand } from './args.js'
import type { Io } from './main.js'

export { applyConfigChange, formatConfig, type ConfigKey } from '../shared/agentConfig.js'

/** Wherever a `defaultAgent` pref lives: the running service (over its RPC) or the
 *  sqlite file directly, when nothing is running to ask instead. */
export interface PrefsStore {
  /** `recover: true` allows a corrupt db to be moved aside and recreated — pass it
   *  only when the caller is about to write anyway (`config set`'s implicit read of
   *  the current agent), never for a read-only command (`config`/`config get`),
   *  which must leave a corrupt file untouched. Ignored by `remoteStore` (the
   *  running service owns recovery there). */
  get(opts?: { recover?: boolean }): Promise<Record<string, string>>
  set(key: string, value: string): Promise<void>
}

/** Everything `runConfig` reaches outside its own process, injectable for tests. */
export interface ConfigDeps {
  target: () => ServiceTarget
  probe: (port: number, host: string) => Promise<HealthInfo | null>
  remote: (t: ServiceTarget) => PrefsStore
  local: (io: Io) => PrefsStore
}

/** Talk `getPrefs`/`setPref` to a running service over its RPC — see `rpc()` in
 *  rpc.ts for the header/host/error-unwrap rules shared with `issueRemote`. */
export function remoteStore(t: ServiceTarget): PrefsStore {
  return {
    get: async () => (await rpc<Record<string, string>>(t, 'getPrefs', [])).value ?? {},
    set: async (key, value) => { await rpc<void>(t, 'setPref', [key, value]) }
  }
}

/** Read/write the prefs table directly. Only used when the health probe says no
 *  service is running — the service owns the db file while it's up (see
 *  src/server/paths.ts) — and validates the write itself since there's no server
 *  handler to do it for us. `dbPath` defaults to the real db but is overridable
 *  for tests. A corrupt db that `openDb` recovers by moving aside is reported to
 *  `io` — silently swapping in a fresh, empty db would otherwise look like the
 *  user's default agent pref just vanished. */
export function localStore(io: Io, dbPath: string = defaultDbPath()): PrefsStore {
  // A single, lazily-opened handle shared across every call this store instance
  // makes (get + set for one `config set`, or just get for `list`/`get`). Opening
  // is dynamic — `openDb` (and node:sqlite with it) is only ever loaded once a CLI
  // command actually needs the local db, so `limn --version` never pulls it in.
  // The handle is never explicitly closed: this store lives only for the lifetime
  // of one CLI invocation, and node:sqlite's synchronous handle holds no event-loop
  // resource that would keep the process alive past `main()` returning.
  let cached: DatabaseSync | undefined
  const open = async (opts: { recover: boolean }): Promise<DatabaseSync> => {
    if (cached) return cached
    const { openDb } = await import('../server/db/db.js')
    const { db, recoveredFrom } = openDb(dbPath, opts)
    if (recoveredFrom) io.err(`note: database was corrupt; a backup was kept at ${recoveredFrom}`)
    cached = db
    return db
  }
  return {
    get: async (opts) => {
      // recover: false by default — a plain read must never rotate the user's
      // database aside; a corrupt file surfaces as a rejection instead (see
      // openDb's `recover` option). `runConfig` opts in to recovery for the
      // implicit read at the start of a `config set`, which writes regardless.
      const db = await open({ recover: opts?.recover ?? false })
      const out: Record<string, string> = {}
      for (const r of db.prepare('SELECT key, value FROM prefs').all() as { key: string; value: string }[]) {
        out[r.key] = r.value
      }
      return out
    },
    set: async (key, value) => {
      if (key === DEFAULT_AGENT_PREF_KEY) {
        const check = validateAgentRefJson(value)
        if (!check.ok) throw new Error(check.error)
        value = JSON.stringify(check.agent)
      }
      const db = await open({ recover: true })
      db.prepare(`INSERT INTO prefs (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value)
    }
  }
}

export const defaultConfigDeps: ConfigDeps = {
  target: serviceTarget,
  probe: probeHealth,
  remote: remoteStore,
  local: (io) => localStore(io)
}

function valueFor(agent: AgentRef, key: ConfigKey): string {
  if (key === 'agent') return agent.engine
  if (key === 'model') return agent.model ?? 'auto'
  return agent.reasoningEffort ?? 'auto'
}

export async function runConfig(cmd: ConfigCommand, io: Io, deps: ConfigDeps = defaultConfigDeps): Promise<number> {
  const target = deps.target()
  try {
    const health = await deps.probe(target.port, target.host)
    const store = health ? deps.remote(target) : deps.local(io)
    // `config set` writes regardless of what this read finds, so a corrupt local db
    // may as well recover here; `config`/`config get` are read-only and must not.
    const prefs = await store.get(cmd.kind === 'config-set' ? { recover: true } : undefined)
    const current = resolveDefaultAgent(prefs)

    if (cmd.kind === 'config-list') {
      io.out(formatConfig(current))
      return 0
    }
    if (cmd.kind === 'config-get') {
      io.out(valueFor(current, cmd.key))
      return 0
    }

    const result = applyConfigChange(current, cmd.key, cmd.value)
    if (!result.ok) { io.err(`limn: ${result.error}`); return 1 }
    await store.set(DEFAULT_AGENT_PREF_KEY, JSON.stringify(result.agent))
    if (result.note) io.out(`note: ${result.note}`)
    io.out(formatConfig(result.agent))
    return 0
  } catch (err) {
    io.err(`limn: ${err instanceof Error ? err.message : String(err)}`)
    return 1
  }
}
