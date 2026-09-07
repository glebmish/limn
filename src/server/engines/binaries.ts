import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { ENGINE_PATH_PREF_KEYS } from '../../shared/prefs.js'

/* Engine CLI resolution: the user's system-installed `claude` / `codex` from
   PATH. Nothing is bundled — packing strips the SDKs' platform binaries (see
   scripts/pack-smoke.sh), so the user supplies the CLIs via their own installs
   and keeps them current.

   Users can override either CLI with an explicit absolute path in Settings.
   Those overrides intentionally win over PATH even when broken, so a stale
   hardcoded path surfaces as an actionable error instead of silently launching a
   different binary. */

type EngineBinary = 'claude' | 'codex'

export interface EngineBinaryStatus {
  configured: boolean
  source: 'configured' | 'path' | 'missing'
  ok: boolean
  path?: string
  hint: string
}

let configuredPaths: Record<EngineBinary, string> = { claude: '', codex: '' }

export function setEngineBinaryPrefs(prefs: Record<string, string>): void {
  configuredPaths = {
    claude: prefs[ENGINE_PATH_PREF_KEYS.claude] ?? '',
    codex: prefs[ENGINE_PATH_PREF_KEYS.codex] ?? ''
  }
}

function fromPath(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue
    const p = path.join(dir, name)
    try {
      // `statSync` FOLLOWS symlinks, so this accepts a symlink to an executable
      // file (the common `npm`/`brew` shim) and rejects one pointing at a directory.
      fs.accessSync(p, fs.constants.X_OK)
      if (fs.statSync(p).isFile()) return p
    } catch {
      // not here
    }
  }
  return undefined
}

function expandConfigured(raw: string): string | undefined {
  const s = raw.trim()
  if (!s) return undefined
  if (s === '~') return os.homedir()
  if (s.startsWith('~/')) return path.join(os.homedir(), s.slice(2))
  return s
}

function executableProblem(file: string): string | undefined {
  if (!path.isAbsolute(file)) return 'Configured path must be absolute.'
  try {
    fs.accessSync(file, fs.constants.X_OK)
    // `statSync` follows symlinks — a symlink to an executable file passes here.
    if (!fs.statSync(file).isFile()) return 'Configured path is not a file.'
    return undefined
  } catch {
    return 'Configured path does not exist or is not executable.'
  }
}

function binaryPath(engine: EngineBinary): string | undefined {
  const configured = expandConfigured(configuredPaths[engine])
  if (configured) return configured
  return fromPath(engine)
}

export function engineBinaryStatus(engine: EngineBinary): EngineBinaryStatus {
  const configured = expandConfigured(configuredPaths[engine])
  if (configured) {
    const problem = executableProblem(configured)
    return {
      configured: true,
      source: 'configured',
      ok: !problem,
      path: configured,
      hint: problem ?? `Using configured ${engine} at ${configured}`
    }
  }

  const found = fromPath(engine)
  if (found) {
    return {
      configured: false,
      source: 'path',
      ok: true,
      path: found,
      hint: `Using ${engine} from PATH at ${found}`
    }
  }

  return {
    configured: false,
    source: 'missing',
    ok: false,
    hint: `${engine} not found on PATH`
  }
}

export function claudeBinaryPath(): string | undefined {
  return binaryPath('claude')
}

export function codexBinaryPath(): string | undefined {
  return binaryPath('codex')
}

export interface EngineVersionInfo { version?: string; warning?: string }

/* Codex CLI floor — the lowest version verified with the codex-acp adapter. Older
   CLIs may authenticate successfully but fail later when the adapter drives them,
   so surface this as an auth/settings hint instead of waiting for an opaque turn failure. */
const CODEX_APP_SERVER_MIN_VERSION = '0.135.0'

const execFileAsync = promisify(execFile)

/* Injectable spawn seam: returns raw `<bin> --version` stdout, or throws.
   Kept internal so tests can stub the output and count spawns. */
type VersionSpawn = (binaryPath: string) => Promise<string>

const defaultVersionSpawn: VersionSpawn = async (bin) => {
  const { stdout } = await execFileAsync(bin, ['--version'], { timeout: 3000 })
  return stdout
}

let versionSpawn: VersionSpawn = defaultVersionSpawn
const versionCache = new Map<string, EngineVersionInfo>()

/** Test-only: replace the version spawn (pass undefined to restore) and reset the cache. */
export function setVersionSpawnForTests(spawn: VersionSpawn | undefined): void {
  versionSpawn = spawn ?? defaultVersionSpawn
  versionCache.clear()
}

/** Numeric triple compare (no semver dep): >0 if a>b, <0 if a<b, 0 if equal. */
function compareTriple(a: string, b: string): number {
  const pa = a.split('.')
  const pb = b.split('.')
  for (let i = 0; i < 3; i++) {
    const diff = Number(pa[i] ?? 0) - Number(pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** Best-effort `<bin> --version` probe: 3 s timeout, first semver in stdout.
 *  Warns below the known-good floor; NEVER blocks or throws. Cached per resolved
 *  path for the process lifetime (the picker re-opens often; binaries don't churn).
 *  EVERY failure mode (unresolved, spawn error, timeout, unparseable) yields `{}`. */
export async function probeEngineVersion(engine: EngineBinary): Promise<EngineVersionInfo> {
  const resolved = binaryPath(engine)
  if (!resolved) return {}

  const cached = versionCache.get(resolved)
  if (cached) return cached

  let info: EngineVersionInfo = {}
  try {
    const version = (await versionSpawn(resolved)).match(/\d+\.\d+\.\d+/)?.[0]
    if (version) {
      info = engine === 'codex' && compareTriple(version, CODEX_APP_SERVER_MIN_VERSION) < 0
        ? {
            version,
            warning: `codex ${version} detected — Limn's Codex app-server integration is tested against ≥${CODEX_APP_SERVER_MIN_VERSION}; consider upgrading`
          }
        : { version }
    }
  } catch {
    // spawn error / timeout / non-zero exit — stay silent, never warn or block
    info = {}
  }
  versionCache.set(resolved, info)
  return info
}
