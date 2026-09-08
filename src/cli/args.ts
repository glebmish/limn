import fs from 'node:fs'
import path from 'node:path'
import type { ConfigKey } from '../shared/agentConfig.js'
import type { AgentOverride } from '../server/cliOpen.js'

export class CliUsageError extends Error {}

export type { ConfigKey }

export type CliCommand =
  | { kind: 'open'; dir: string; base?: string; compare?: string; hub: boolean; fresh: boolean; noService: boolean; generate: boolean; printUrl: boolean; agent?: AgentOverride }
  | { kind: 'serve'; port?: number; port80: boolean }
  | { kind: 'service-install'; port80: boolean }
  | { kind: 'service-uninstall' }
  | { kind: 'service-status' }
  | { kind: 'service-logs'; follow: boolean }
  | { kind: 'config-list' }
  | { kind: 'config-get'; key: ConfigKey }
  | { kind: 'config-set'; key: ConfigKey; value: string }
  | { kind: 'version' }
  | { kind: 'help'; topic?: 'service' | 'config' }

/** The three `config-*` command kinds — the shape `runConfig` accepts. */
export type ConfigCommand = Extract<CliCommand, { kind: 'config-list' | 'config-get' | 'config-set' }>

const SERVICE_COMMANDS = ['serve', 'install', 'uninstall', 'status', 'logs']
const CONFIG_KEYS: ConfigKey[] = ['agent', 'model', 'effort']

/** `--name value` / `--name=value` reader shared by every command. */
function takeValue(argv: string[], i: number, name: string): [string, number] {
  const tok = argv[i]
  if (tok.startsWith(`${name}=`)) {
    const v = tok.slice(name.length + 1)
    if (v === '') throw new CliUsageError(`${name} needs a value`)
    return [v, i]
  }
  const next = argv[i + 1]
  if (next === undefined || next.startsWith('-')) throw new CliUsageError(`${name} needs a value`)
  return [next, i + 1]
}

/** Also used to validate LIMN_PORT (target.ts's `resolvePort`), so a typo'd env var
 *  gets the same friendly error a bad `--port` does, instead of silently falling back. */
export function parsePort(raw: string): number {
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new CliUsageError(`--port must be an integer 0-65535, got "${raw}"`)
  return n
}

/** A boolean flag token that rejects a bogus `=value` suffix (it takes none). */
function boolFlag(tok: string, name: string): boolean {
  if (tok !== name && tok.startsWith(`${name}=`)) throw new CliUsageError(`flag ${name} takes no value`)
  return tok === name
}

function parseOpen(argv: string[], cwd: string): CliCommand {
  const out: Extract<CliCommand, { kind: 'open' }> = { kind: 'open', dir: cwd, hub: false, fresh: false, noService: false, generate: false, printUrl: false }
  const agent: AgentOverride = {}
  let agentTouched = false
  let dirTaken = false
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]
    if (tok === '--base' || tok.startsWith('--base=')) { [out.base, i] = takeValue(argv, i, '--base'); continue }
    if (tok === '--branch' || tok.startsWith('--branch=')) { [out.compare, i] = takeValue(argv, i, '--branch'); continue }
    if (tok === '--new' || tok.startsWith('--new=')) { out.fresh = boolFlag(tok, '--new'); continue }
    if (tok === '--hub' || tok.startsWith('--hub=')) { out.hub = boolFlag(tok, '--hub'); continue }
    if (tok === '--no-service' || tok.startsWith('--no-service=')) { out.noService = boolFlag(tok, '--no-service'); continue }
    if (tok === '--generate' || tok.startsWith('--generate=')) { out.generate = boolFlag(tok, '--generate'); continue }
    if (tok === '--print-url' || tok.startsWith('--print-url=')) { out.printUrl = boolFlag(tok, '--print-url'); continue }
    if (tok === '--agent' || tok.startsWith('--agent=')) { [agent.engine, i] = takeValue(argv, i, '--agent'); agentTouched = true; continue }
    if (tok === '--model' || tok.startsWith('--model=')) { [agent.model, i] = takeValue(argv, i, '--model'); agentTouched = true; continue }
    if (tok === '--effort' || tok.startsWith('--effort=')) { [agent.effort, i] = takeValue(argv, i, '--effort'); agentTouched = true; continue }
    if (tok.startsWith('-')) throw new CliUsageError(`unknown flag ${tok}`)
    if (dirTaken) throw new CliUsageError(`unexpected argument "${tok}"`)
    dirTaken = true
    out.dir = path.resolve(cwd, tok)
  }
  if (agentTouched && !out.generate) throw new CliUsageError('--agent/--model/--effort need --generate')
  if (out.generate && out.hub) throw new CliUsageError('--generate cannot be combined with --hub')
  if (agentTouched) out.agent = agent
  return out
}

/** An allowed flag for a `service` subcommand: `takesValue: false` rejects a `=value` suffix. */
type AllowedFlag = { name: string; takesValue: boolean }

function parseService(argv: string[]): CliCommand {
  const [sub, ...rest] = argv
  if (!sub || sub === '--help' || sub === '-h') return { kind: 'help', topic: 'service' }
  const flag = (name: string): boolean => rest.includes(name)
  /** Every token must be an allowed flag or the value of one; a stray positional is a
   *  mistake (`service logs limn.log`) rather than something to ignore. */
  const reject = (allowed: AllowedFlag[]): void => {
    for (let i = 0; i < rest.length; i++) {
      const t = rest[i]
      if (!t.startsWith('-')) throw new CliUsageError(`unexpected argument "${t}"`)
      const eq = t.indexOf('=')
      const name = eq === -1 ? t : t.slice(0, eq)
      const match = allowed.find((a) => a.name === name)
      if (!match) throw new CliUsageError(`unknown flag ${t}`)
      if (eq !== -1 && !match.takesValue) throw new CliUsageError(`flag ${name} takes no value`)
      if (eq === -1 && match.takesValue) i++ // the next token is its value
    }
  }
  switch (sub) {
    case 'serve': {
      reject([{ name: '--port', takesValue: true }, { name: '--port-80', takesValue: false }])
      const out: Extract<CliCommand, { kind: 'serve' }> = { kind: 'serve', port80: flag('--port-80') }
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === '--port' || rest[i].startsWith('--port=')) { const [v, j] = takeValue(rest, i, '--port'); out.port = parsePort(v); i = j }
      }
      return out
    }
    case 'install': reject([{ name: '--port-80', takesValue: false }]); return { kind: 'service-install', port80: flag('--port-80') }
    case 'uninstall': reject([]); return { kind: 'service-uninstall' }
    case 'status': reject([]); return { kind: 'service-status' }
    case 'logs': reject([{ name: '-f', takesValue: false }, { name: '--follow', takesValue: false }]); return { kind: 'service-logs', follow: flag('-f') || flag('--follow') }
    default: throw new CliUsageError(`unknown service command "${sub}" (serve, install, uninstall, status, logs)`)
  }
}

function parseConfigKey(key: string): ConfigKey {
  if ((CONFIG_KEYS as string[]).includes(key)) return key as ConfigKey
  throw new CliUsageError(`unknown config key "${key}" (${CONFIG_KEYS.join(', ')})`)
}

function parseConfig(argv: string[]): CliCommand {
  const [sub, ...rest] = argv
  if (!sub) return { kind: 'config-list' }
  if (sub === '--help' || sub === '-h') return { kind: 'help', topic: 'config' }
  switch (sub) {
    case 'get': {
      const [key, extra] = rest
      if (!key) throw new CliUsageError('config get needs a key')
      if (extra !== undefined) throw new CliUsageError(`unexpected argument "${extra}"`)
      return { kind: 'config-get', key: parseConfigKey(key) }
    }
    case 'set': {
      const [key, value, extra] = rest
      if (!key || value === undefined) throw new CliUsageError('config set needs a key and a value')
      if (extra !== undefined) throw new CliUsageError(`unexpected argument "${extra}"`)
      return { kind: 'config-set', key: parseConfigKey(key), value }
    }
    default: throw new CliUsageError(`unknown config command "${sub}" (get, set)`)
  }
}

export function parseArgs(argv: string[], cwd: string): CliCommand {
  const [first] = argv
  if (first === '--version' || first === '-v') return { kind: 'version' }
  if (first === '--help' || first === '-h') return { kind: 'help' }
  if (first === 'service') return parseService(argv.slice(1))
  if (first === 'config') return parseConfig(argv.slice(1))
  if (first === 'open') return parseOpen(argv.slice(1), cwd)

  // Anything else is a positional `open` dir — unless it's a bare word that
  // both isn't a path and doesn't exist on disk, in which case it's a typo
  // for one of the `service` subcommands or just unknown.
  if (first !== undefined && !first.startsWith('-') && !first.includes('/') && !first.includes('\\') && !fs.existsSync(path.resolve(cwd, first))) {
    if (SERVICE_COMMANDS.includes(first)) throw new CliUsageError(`unknown command "${first}" — did you mean "limn service ${first}"?`)
    throw new CliUsageError(`unknown command "${first}"`)
  }
  return parseOpen(argv, cwd)
}
