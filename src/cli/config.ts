import { openDb } from '../server/db/db.js'
import { defaultDbPath } from '../server/paths.js'
import { probeHealth, type HealthInfo } from './health.js'
import { serviceTarget, type ServiceTarget } from './target.js'
import { rpc } from './rpc.js'
import { validateAgentRef, validateAgentRefJson } from '../shared/agents.js'
import { resolveDefaultAgent, DEFAULT_AGENT_PREF_KEY } from '../shared/prefs.js'
import type { AgentRef } from '../shared/types.js'
import type { ConfigCommand, ConfigKey } from './args.js'
import type { Io } from './main.js'

/** Wherever a `defaultAgent` pref lives: the running service (over its RPC) or the
 *  sqlite file directly, when nothing is running to ask instead. */
export interface PrefsStore {
  get(): Promise<Record<string, string>>
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
  const open = () => {
    const { db, recoveredFrom } = openDb(dbPath)
    if (recoveredFrom) io.err(`note: database was corrupt; a backup was kept at ${recoveredFrom}`)
    return db
  }
  return {
    get: async () => {
      const db = open()
      try {
        const out: Record<string, string> = {}
        for (const r of db.prepare('SELECT key, value FROM prefs').all() as { key: string; value: string }[]) {
          out[r.key] = r.value
        }
        return out
      } finally {
        db.close()
      }
    },
    set: async (key, value) => {
      if (key === DEFAULT_AGENT_PREF_KEY) {
        const check = validateAgentRefJson(value)
        if (!check.ok) throw new Error(check.error)
        value = JSON.stringify(check.agent)
      }
      const db = open()
      try {
        db.prepare(`INSERT INTO prefs (key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value)
      } finally {
        db.close()
      }
    }
  }
}

export const defaultConfigDeps: ConfigDeps = {
  target: serviceTarget,
  probe: probeHealth,
  remote: remoteStore,
  local: (io) => localStore(io)
}

/** Pure: apply one key change to an AgentRef, returning a validated next ref (or the
 *  validation error) plus an optional note when a change silently drops a value that
 *  no longer applies (an engine switch resets model/effort; a model switch that can't
 *  keep the current effort resets effort). */
export function applyConfigChange(current: AgentRef, key: ConfigKey, value: string): { ok: true; agent: AgentRef; note?: string } | { ok: false; error: string } {
  if (key === 'agent') {
    const check = validateAgentRef({ engine: value })
    if (!check.ok) return { ok: false, error: check.error }
    const nextEngine = check.agent.engine
    if (nextEngine === current.engine) return { ok: true, agent: current }
    const hadExtra = current.model !== undefined || current.reasoningEffort !== undefined
    return {
      ok: true,
      agent: { engine: nextEngine },
      note: hadExtra ? `model and effort reset to auto (not available for ${nextEngine})` : undefined
    }
  }

  if (key === 'model') {
    if (value === 'auto') return { ok: true, agent: { engine: current.engine } }
    const withEffort = validateAgentRef({ engine: current.engine, model: value, reasoningEffort: current.reasoningEffort })
    if (withEffort.ok) return { ok: true, agent: withEffort.agent }
    if (current.reasoningEffort === undefined) return { ok: false, error: withEffort.error }
    // the model itself may still be fine — it's just incompatible with the effort
    // that was set for the old model. Drop the effort rather than failing outright.
    const withoutEffort = validateAgentRef({ engine: current.engine, model: value })
    if (!withoutEffort.ok) return { ok: false, error: withEffort.error }
    return { ok: true, agent: withoutEffort.agent, note: `effort reset to auto (not available for ${value})` }
  }

  // key === 'effort'
  if (value === 'auto') {
    return { ok: true, agent: current.model !== undefined ? { engine: current.engine, model: current.model } : { engine: current.engine } }
  }
  const check = validateAgentRef({ engine: current.engine, model: current.model, reasoningEffort: value })
  if (!check.ok) return { ok: false, error: check.error }
  return { ok: true, agent: check.agent }
}

/** "agent   claude\nmodel   auto\neffort  auto" — labels padded to one column. */
export function formatConfig(agent: AgentRef): string {
  const rows: [string, string][] = [
    ['agent', agent.engine],
    ['model', agent.model ?? 'auto'],
    ['effort', agent.reasoningEffort ?? 'auto']
  ]
  return rows.map(([k, v]) => `${k.padEnd(8)}${v}`).join('\n')
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
    const prefs = await store.get()
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
