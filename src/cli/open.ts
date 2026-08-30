import type { CliCommand } from './args.js'
import type { Io } from './main.js'

export type OpenCommand = Extract<CliCommand, { kind: 'open' }>

/** Review a directory: hand it to a running service, or start one. */
export async function runOpen(_cmd: OpenCommand, io: Io): Promise<number> {
  io.err('open: not implemented yet')
  return 1
}
