import type { CliCommand } from '../args.js'
import type { Io } from '../main.js'

export type ServiceCommand = Extract<CliCommand, { kind: `service-${string}` }>

/** True when a launchd/systemd unit for Limn is on disk. */
export async function isServiceInstalled(): Promise<boolean> {
  return false
}

/** Write the unit, load it, and wait for the service to answer /health. */
export async function installService(_opts: { port80: boolean }, io: Io): Promise<number> {
  io.err('service install: not implemented yet')
  return 1
}

/** install / uninstall / status / logs. */
export async function runServiceCommand(_cmd: ServiceCommand, io: Io): Promise<number> {
  io.err('service: not implemented yet')
  return 1
}
