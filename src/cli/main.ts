import readline from 'node:readline'
import { parseArgs, CliUsageError } from './args.js'
import { APP_VERSION } from '../server/http.js'
import { runServe } from './serve.js'
import { runOpen } from './open.js'
import { runServiceCommand } from './service/index.js'

export interface Io {
  out(line: string): void
  err(line: string): void
  isTTY: boolean
  /** y/N prompt; resolves false when not a TTY */
  ask(question: string): Promise<boolean>
}

export function defaultIo(): Io {
  const isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY)
  return {
    out: (l) => { console.log(l) },
    err: (l) => { console.error(l) },
    isTTY,
    ask: (q) => new Promise((resolve) => {
      if (!isTTY) { resolve(false); return }
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
      let answer = false
      // 'close' is the single resolve path, so an answer, an EOF and a Ctrl-C at the
      // prompt all close the interface — an open one holds stdin and blocks exit.
      rl.once('close', () => { resolve(answer) })
      rl.question(`${q} [Y/n] `, (a) => { answer = !/^n/i.test(a.trim()); rl.close() })
    })
  }
}

export const HELP = `limn — agentic local branch review, in your browser

usage:
  limn [DIR] [--base REF] [--branch BRANCH] [--new] [--hub] [--no-service]
  limn open …                      same as above
  limn service <command>           background service (limn service --help)
  limn --version | --help

open: review DIR (default: current directory). If a Limn service is running it
opens there; otherwise a server is started for you.`

export const HELP_SERVICE = `limn service — the always-on Limn server

  serve [--port N] [--port-80]   run the server in the foreground (default port 5466)
  install [--port-80]            install + start the background service (launchd / systemd --user)
  uninstall                      stop and remove the background service (database untouched)
  status                         activation, URL, pid, node path, native stop/restart commands
  logs [-f]                      show (or follow) the service log`

export async function main(argv: string[], io: Io = defaultIo()): Promise<number> {
  let cmd
  try { cmd = parseArgs(argv, process.cwd()) } catch (err) {
    if (err instanceof CliUsageError) { io.err(`limn: ${err.message}`); io.err(HELP); return 2 }
    throw err
  }
  switch (cmd.kind) {
    case 'version': io.out(`limn ${APP_VERSION}`); return 0
    case 'help': io.out(cmd.topic === 'service' ? HELP_SERVICE : HELP); return 0
    case 'serve': return runServe(cmd, io)
    case 'open': return runOpen(cmd, io)
    default: return runServiceCommand(cmd, io)
  }
}
