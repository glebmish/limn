import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import type { EngineId, ExecutionMode, ReasoningEffort } from '../../shared/types.js'

/** Per-engine ACP adapter config. One small record replaces a whole hand-written
 *  engine client — the mode-id mapping, per-turn spawn env, and effort mechanism
 *  are the only engine-specific knobs `AcpEngine` needs (spec §D1). */
export interface AcpEngineConfig {
  id: EngineId
  /** absolute node_modules path to the adapter's `dist/index.js`. */
  adapterEntry: string
  /** ACP session mode id for a tier + write flag (spike-measured, spec §D3). */
  modeFor: (mode: ExecutionMode, writeEnabled: boolean) => string
  /** per-turn spawn env (e.g. `ANTHROPIC_MODEL`); one process per turn makes it exact. */
  env?: (turn: { model?: string; reasoningEffort?: ReasoningEffort }) => Record<string, string>
  /** per-turn ACP session config options applied post-session via
   *  `setSessionConfigOption` (Codex: `model` + `reasoning_effort`; Claude: `effort`).
   *  Best-effort — the engine swallows unknown/unsupported option ids. */
  configOptions?: (turn: { model?: string; reasoningEffort?: ReasoningEffort }) => { configId: string; value: string }[]
}

const require_ = createRequire(import.meta.url)

/** Resolve an adapter package's spawnable entry from `node_modules`: read its
 *  `package.json` `bin` (single-command adapters expose one bin path) and join it
 *  onto the package dir. `override` (Settings/env escape hatch, OQ9) wins when set. */
export function resolveAdapterEntry(pkg: string, override?: string): string {
  if (override) return override
  const pkgJsonPath = require_.resolve(`${pkg}/package.json`)
  const pkgDir = path.dirname(pkgJsonPath)
  const pkgJson = require_(`${pkg}/package.json`) as { bin?: string | Record<string, string>; main?: string }
  const binRel =
    typeof pkgJson.bin === 'string'
      ? pkgJson.bin
      : pkgJson.bin
        ? Object.values(pkgJson.bin)[0]
        : pkgJson.main
  if (!binRel) throw new Error(`adapter ${pkg} has no bin/main entry`)
  return path.join(pkgDir, binRel)
}

/** Spawn an ACP adapter as a child process using Electron's own Node
 *  (`process.execPath` + `ELECTRON_RUN_AS_NODE`), in its own process group
 *  (`detached`) so cancel can kill the whole tree. `process.env` is inherited so
 *  the adapter finds the user's `~/.claude` creds; per-turn `env` is layered on. */
export function spawnAdapter(entry: string, env: Record<string, string>): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [entry], {
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...env }
  }) as ChildProcessWithoutNullStreams
}

/** Claude's `configOptions` effort mapping: Claude's `effort` config option offers
 *  `default/low/medium/high/xhigh/max` — no `minimal`, so Limn's `minimal` clamps up
 *  to `low`; every other Limn value passes through unchanged. Exported for tests. */
export function claudeEffort(effort: ReasoningEffort): string {
  return effort === 'minimal' ? 'low' : effort
}

/** Claude adapter config (spike-confirmed mode ids + `ANTHROPIC_MODEL` env). The
 *  adapter path resolves from `node_modules` at load; `LIMN_CLAUDE_ADAPTER` overrides. */
export const CLAUDE_ACP_CONFIG: AcpEngineConfig = {
  id: 'claude',
  adapterEntry: resolveAdapterEntry('@agentclientprotocol/claude-agent-acp', process.env.LIMN_CLAUDE_ADAPTER),
  modeFor: (mode, writeEnabled) =>
    !writeEnabled ? 'default' : ({ ask: 'default', edits: 'acceptEdits', auto: 'acceptEdits', full: 'bypassPermissions' }[mode] ?? 'default'),
  env: (t): Record<string, string> => (t.model ? { ANTHROPIC_MODEL: t.model } : {}),
  configOptions: (t) => (t.reasoningEffort ? [{ configId: 'effort', value: claudeEffort(t.reasoningEffort) }] : [])
}

/** Codex's `configOptions` effort mapping: Codex's `reasoning_effort` config option
 *  offers `low/medium/high/xhigh` only — no `minimal`/`max`, so Limn's `minimal`
 *  clamps up to `low` and `max` clamps down to `xhigh`; everything else passes
 *  through unchanged. Exported for tests. */
export function codexEffort(effort: ReasoningEffort): string {
  if (effort === 'minimal') return 'low'
  if (effort === 'max') return 'xhigh'
  return effort
}

/** Codex adapter config (spike-confirmed mode ids). Unlike Claude, Codex has no
 *  model spawn env var — both model AND reasoning effort go through the
 *  `session/set_config_option` channel (spike §3: `configId` `model` /
 *  `reasoning_effort`). The adapter path resolves from `node_modules` at load;
 *  `LIMN_CODEX_ADAPTER` overrides. */
export const CODEX_ACP_CONFIG: AcpEngineConfig = {
  id: 'codex',
  adapterEntry: resolveAdapterEntry('@agentclientprotocol/codex-acp', process.env.LIMN_CODEX_ADAPTER),
  modeFor: (mode, writeEnabled) =>
    !writeEnabled ? 'read-only' : ({ ask: 'read-only', edits: 'agent', auto: 'agent', full: 'agent-full-access' }[mode] ?? 'read-only'),
  configOptions: (t) => [
    ...(t.model ? [{ configId: 'model', value: t.model }] : []),
    ...(t.reasoningEffort ? [{ configId: 'reasoning_effort', value: codexEffort(t.reasoningEffort) }] : [])
  ]
}
