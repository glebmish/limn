import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ENGINE_PATH_PREF_KEYS } from '../../shared/prefs.js'

/* Engine CLI resolution: the user's system-installed `claude` / `codex` from
   PATH. Nothing is bundled — the SDKs' platform binaries are excluded from the
   app package (see electron-builder.yml), so the user supplies the CLIs via
   their own installs and keeps them current.

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
      fs.accessSync(p, fs.constants.X_OK)
      if (fs.statSync(p).isFile() || fs.lstatSync(p).isSymbolicLink()) return p
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
    const st = fs.statSync(file)
    if (!st.isFile() && !fs.lstatSync(file).isSymbolicLink()) return 'Configured path is not a file.'
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
