import { Readable, Writable } from 'node:stream'
import type { DatabaseSync } from 'node:sqlite'
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION, type Client, type SessionNotification } from '@agentclientprotocol/sdk'
import type { EngineId } from '../../shared/types.js'
import { bareSkillName, type CommandAvailability, type ProbeState } from '../../shared/actions.js'
import { spawnAdapter, type AcpEngineConfig } from './adapters.js'
import { engineBinaryStatus } from './binaries.js'
import { killTree } from './acp.js'

// The command probe (design board 14 N2). Not a tool the agent calls: when an ACP
// session opens, the engine announces `available_commands_update` — the skills the
// reviewer can pin as actions. The probe opens a session, reads that one
// announcement, and closes: no prompt, no chat thread, no tokens. One record per
// engine per repo, cached in prefs with a timestamp.
//
// Probe-verified spellings (2026-09-07, this repo): claude-agent-acp lists skills
// BARE ("simplify", "pr-review-toolkit:review-pr") among ~70 built-ins
// ("compact", "init", …) ~5 ms after session/new; codex-acp lists skills as
// "$name" and its built-ins bare ("review", "compact") within ~300 ms.

export type { CommandAvailability, ProbeState }

/** The skill names in an engine's announcement, bare. Claude cannot tell a skill from
 *  a built-in, so every name counts; Codex marks skills with `$`. */
export function skillNames(engine: EngineId, names: readonly string[]): string[] {
  if (engine === 'codex') return names.filter((n) => n.startsWith('$')).map((n) => n.slice(1))
  return [...names]
}

/** True when the engine's last probe reported the skill. Anything but an `ok`/`empty`
 *  record answers no — a skill action is runnable only where its name appears. */
export function hasSkill(avail: CommandAvailability | undefined, name: string): boolean {
  if (!avail || (avail.state !== 'ok' && avail.state !== 'empty')) return false
  return skillNames(avail.engine, avail.names).includes(bareSkillName(name))
}

/** True when this engine can be spawned at all (mirrors acp.ts's spawn gate): an
 *  adapter that must have a native binary, or a configured-but-broken path, is out. */
export function engineSpawnable(config: AcpEngineConfig): boolean {
  const st = engineBinaryStatus(config.id)
  return !((config.binaryRequired || st.configured) && !st.ok)
}

/** Spawn the adapter, open a session in `repo`, wait for its command list, kill it. */
export async function probeCommands(
  config: AcpEngineConfig, repo: string, opts: { timeoutMs?: number } = {}
): Promise<{ names: string[] } | { error: string }> {
  const timeoutMs = opts.timeoutMs ?? 4000
  if (!engineSpawnable(config)) return { error: engineBinaryStatus(config.id).hint }
  const child = spawnAdapter(config.adapterEntry, { ...(config.env?.({}) ?? {}), ...(config.binaryEnv?.() ?? {}) })
  let stderrTail = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (d: string) => { stderrTail = (stderrTail + d).slice(-2000) })
  let names: string[] | null = null
  let announce: () => void = () => {}
  const announced = new Promise<void>((res) => { announce = res })
  const exited = new Promise<never>((_, rej) => {
    child.on('error', (e) => rej(new Error(`adapter failed to start: ${e.message}`)))
    child.on('exit', (code) => rej(new Error(`adapter exited (${code ?? 'signal'})${stderrTail ? `: ${stderrTail.trim().split('\n').slice(-2).join(' ')}` : ''}`)))
  })
  const client: Client = {
    sessionUpdate: (p: SessionNotification): void => {
      if (p.update.sessionUpdate === 'available_commands_update') {
        names = p.update.availableCommands.map((c) => c.name)
        announce()
      }
    },
    requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
    readTextFile: () => { throw new Error('fs.readTextFile declined') },
    writeTextFile: () => { throw new Error('fs.writeTextFile declined') }
  }
  try {
    const conn = new ClientSideConnection(() => client, ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>
    ))
    const work = (async (): Promise<{ names: string[] }> => {
      await conn.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } })
      await conn.newSession({ cwd: repo, mcpServers: [] })
      await Promise.race([announced, new Promise<void>((res) => setTimeout(res, timeoutMs))])
      // no announcement inside the wait is a legitimate answer: an empty list
      return { names: names ?? [] }
    })()
    return await Promise.race([work, exited])
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  } finally {
    killTree(child)
  }
}

const PREF_PREFIX = 'commands:'
const prefKey = (engine: EngineId, repo: string): string => `${PREF_PREFIX}${engine}:${repo}`

/** Stored probe results (`commands:<engine>:<repo>` prefs rows) plus the in-memory
 *  "checking" overlay for probes in flight. */
export class CommandCache {
  private checking = new Set<string>()

  constructor(private readonly db: DatabaseSync) {}

  get(repo: string, engines: readonly EngineId[]): CommandAvailability[] {
    return engines.map((engine) => {
      const row = this.db.prepare('SELECT value FROM prefs WHERE key = ?').get(prefKey(engine, repo)) as { value: string } | undefined
      const stored = row ? parseStored(row.value) : null
      const base: CommandAvailability = stored
        ? { engine, repo, names: stored.names, checkedAt: stored.checkedAt, state: stored.state, ...(stored.error ? { error: stored.error } : {}) }
        : { engine, repo, names: [], checkedAt: '', state: 'unknown' }
      return this.checking.has(prefKey(engine, repo)) ? { ...base, state: 'checking' } : base
    })
  }

  set(a: CommandAvailability): void {
    const value = JSON.stringify({ names: a.names, checkedAt: a.checkedAt, state: a.state, ...(a.error ? { error: a.error } : {}) })
    this.db.prepare('INSERT INTO prefs (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(prefKey(a.engine, a.repo), value)
  }

  markChecking(engine: EngineId, repo: string, on: boolean): void {
    if (on) this.checking.add(prefKey(engine, repo))
    else this.checking.delete(prefKey(engine, repo))
  }

  /** Every skill name any probe has ever reported, per engine, across repos — what
   *  the Settings editor offers as "seen on <engine>". Sorted, deduped. */
  seen(): { engine: EngineId; names: string[] }[] {
    const rows = this.db.prepare('SELECT key, value FROM prefs WHERE key LIKE ?').all(`${PREF_PREFIX}%`) as { key: string; value: string }[]
    const out: Record<EngineId, Set<string>> = { claude: new Set(), codex: new Set() }
    for (const r of rows) {
      const engine = r.key.slice(PREF_PREFIX.length).split(':')[0] as EngineId
      if (!(engine in out)) continue
      const stored = parseStored(r.value)
      if (!stored) continue
      for (const n of skillNames(engine, stored.names)) out[engine].add(n)
    }
    return (['claude', 'codex'] as EngineId[]).map((engine) => ({ engine, names: [...out[engine]].sort() }))
  }
}

function parseStored(json: string): { names: string[]; checkedAt: string; state: ProbeState; error?: string } | null {
  try {
    const v = JSON.parse(json) as { names?: unknown; checkedAt?: unknown; state?: unknown; error?: unknown }
    if (!Array.isArray(v.names) || typeof v.checkedAt !== 'string') return null
    const state = v.state === 'ok' || v.state === 'empty' || v.state === 'failed' ? v.state : 'unknown'
    return { names: v.names.filter((n): n is string => typeof n === 'string'), checkedAt: v.checkedAt, state, ...(typeof v.error === 'string' ? { error: v.error } : {}) }
  } catch { return null }
}

/** Runs probes and records their outcome. A probe already in flight for an
 *  engine × repo is joined, never duplicated. */
export class CommandProber {
  private inFlight = new Map<string, Promise<CommandAvailability>>()

  constructor(
    private readonly cache: CommandCache,
    private readonly configs: Record<EngineId, AcpEngineConfig>,
    private readonly opts: { timeoutMs?: number; now?: () => string } = {}
  ) {}

  /** The engines worth probing: those that can be spawned. */
  spawnable(): EngineId[] {
    return (Object.keys(this.configs) as EngineId[]).filter((e) => engineSpawnable(this.configs[e]))
  }

  run(repo: string, engines: readonly EngineId[]): Promise<CommandAvailability[]> {
    return Promise.all(engines.map((engine) => this.probeOne(repo, engine)))
  }

  private probeOne(repo: string, engine: EngineId): Promise<CommandAvailability> {
    const key = prefKey(engine, repo)
    const running = this.inFlight.get(key)
    if (running) return running
    this.cache.markChecking(engine, repo, true)
    const p = (async (): Promise<CommandAvailability> => {
      const res = await probeCommands(this.configs[engine], repo, { timeoutMs: this.opts.timeoutMs })
      const checkedAt = this.opts.now?.() ?? new Date().toISOString()
      const record: CommandAvailability = 'error' in res
        ? { engine, repo, names: [], checkedAt, state: 'failed', error: res.error }
        : { engine, repo, names: res.names, checkedAt, state: skillNames(engine, res.names).length ? 'ok' : 'empty' }
      this.cache.markChecking(engine, repo, false)
      this.cache.set(record)
      return record
    })()
    this.inFlight.set(key, p)
    void p.finally(() => { this.inFlight.delete(key) })
    return p
  }
}
