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
  /** how reasoning effort is applied post-session: 'config-option' →
   *  `setSessionConfigOption({ configId: 'effort' })`. */
  effortVia?: 'config-option'
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

/** Claude adapter config (spike-confirmed mode ids + `ANTHROPIC_MODEL` env). The
 *  adapter path resolves from `node_modules` at load; `LIMN_CLAUDE_ADAPTER` overrides. */
export const CLAUDE_ACP_CONFIG: AcpEngineConfig = {
  id: 'claude',
  adapterEntry: resolveAdapterEntry('@agentclientprotocol/claude-agent-acp', process.env.LIMN_CLAUDE_ADAPTER),
  modeFor: (mode, writeEnabled) =>
    !writeEnabled ? 'default' : ({ ask: 'default', edits: 'acceptEdits', auto: 'acceptEdits', full: 'bypassPermissions' }[mode] ?? 'default'),
  env: (t): Record<string, string> => (t.model ? { ANTHROPIC_MODEL: t.model } : {}),
  effortVia: 'config-option'
}
