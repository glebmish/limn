import fs from 'node:fs'
import path from 'node:path'

export class CliUsageError extends Error {}

export type CliCommand =
  | { kind: 'open'; dir: string; base?: string; compare?: string; hub: boolean; fresh: boolean; noService: boolean }
  | { kind: 'serve'; port?: number; port80: boolean }
  | { kind: 'service-install'; port80: boolean }
  | { kind: 'service-uninstall' }
  | { kind: 'service-status' }
  | { kind: 'service-logs'; follow: boolean }
  | { kind: 'version' }
  | { kind: 'help'; topic?: 'service' }

const SERVICE_COMMANDS = ['serve', 'install', 'uninstall', 'status', 'logs']

/** `--name value` / `--name=value` reader shared by every command. */
function takeValue(argv: string[], i: number, name: string): [string, number] {
  const tok = argv[i]
  if (tok.startsWith(`${name}=`)) return [tok.slice(name.length + 1), i]
  const next = argv[i + 1]
  if (next === undefined || next.startsWith('-')) throw new CliUsageError(`${name} needs a value`)
  return [next, i + 1]
}

function parsePort(raw: string): number {
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new CliUsageError(`--port must be an integer 0-65535, got "${raw}"`)
  return n
}

function parseOpen(argv: string[], cwd: string): CliCommand {
  const out: Extract<CliCommand, { kind: 'open' }> = { kind: 'open', dir: cwd, hub: false, fresh: false, noService: false }
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]
    if (tok === '--base' || tok.startsWith('--base=')) { [out.base, i] = takeValue(argv, i, '--base'); continue }
    if (tok === '--branch' || tok.startsWith('--branch=')) { [out.compare, i] = takeValue(argv, i, '--branch'); continue }
    if (tok === '--new') { out.fresh = true; continue }
    if (tok === '--hub') { out.hub = true; continue }
    if (tok === '--no-service') { out.noService = true; continue }
    if (tok.startsWith('-')) throw new CliUsageError(`unknown flag ${tok}`)
    out.dir = path.resolve(cwd, tok)
  }
  return out
}

function parseService(argv: string[]): CliCommand {
  const [sub, ...rest] = argv
  if (!sub || sub === '--help' || sub === '-h') return { kind: 'help', topic: 'service' }
  const flag = (name: string): boolean => rest.includes(name)
  const reject = (allowed: string[]): void => {
    for (const t of rest) if (t.startsWith('-') && !allowed.some((a) => t === a || t.startsWith(`${a}=`))) throw new CliUsageError(`unknown flag ${t}`)
  }
  switch (sub) {
    case 'serve': {
      reject(['--port', '--port-80'])
      const out: Extract<CliCommand, { kind: 'serve' }> = { kind: 'serve', port80: flag('--port-80') }
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === '--port' || rest[i].startsWith('--port=')) { const [v, j] = takeValue(rest, i, '--port'); out.port = parsePort(v); i = j }
      }
      return out
    }
    case 'install': reject(['--port-80']); return { kind: 'service-install', port80: flag('--port-80') }
    case 'uninstall': reject([]); return { kind: 'service-uninstall' }
    case 'status': reject([]); return { kind: 'service-status' }
    case 'logs': reject(['-f', '--follow']); return { kind: 'service-logs', follow: flag('-f') || flag('--follow') }
    default: throw new CliUsageError(`unknown service command "${sub}" (serve, install, uninstall, status, logs)`)
  }
}

export function parseArgs(argv: string[], cwd: string): CliCommand {
  const [first] = argv
  if (first === '--version' || first === '-v') return { kind: 'version' }
  if (first === '--help' || first === '-h') return { kind: 'help' }
  if (first === 'service') return parseService(argv.slice(1))
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
