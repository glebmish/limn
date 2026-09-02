import readline from 'node:readline'
import { parseArgs, CliUsageError } from './args.js'
import { APP_VERSION } from '../server/http.js'
import { runServe } from './serve.js'
import { runOpen } from './open.js'
import { runServiceCommand } from './service/index.js'
import { runConfig } from './config.js'

export interface Io {
  out(line: string): void
  err(line: string): void
  isTTY: boolean
  /** y/N prompt; resolves false when not a TTY. `defaultYes` (the default) decides what
   *  a bare Enter means — set it false for anything destructive. */
  ask(question: string, opts?: { defaultYes?: boolean }): Promise<boolean>
}

/** What a y/N answer means. A bare Enter takes the default — which is why anything
 *  destructive passes `defaultYes: false` rather than relying on "not n". */
export function interpretAnswer(input: string, defaultYes: boolean): boolean {
  const t = input.trim()
  if (t === '') return defaultYes
  return /^y/i.test(t)
}

export function defaultIo(): Io {
  const isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY)
  return {
    out: (l) => { console.log(l) },
    err: (l) => { console.error(l) },
    isTTY,
    ask: (q, opts) => new Promise((resolve) => {
      if (!isTTY) { resolve(false); return }
      const defaultYes = opts?.defaultYes ?? true
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
      let answer = false
      // 'close' is the single resolve path, so an answer, an EOF and a Ctrl-C at the
      // prompt all close the interface — an open one holds stdin and blocks exit.
      rl.once('close', () => { resolve(answer) })
      rl.question(`${q} [${defaultYes ? 'Y/n' : 'y/N'}] `, (a) => {
        answer = interpretAnswer(a, defaultYes)
        rl.close()
      })
    })
  }
}

export const HELP = `limn — agentic local branch review, in your browser

usage:
  limn [DIR] [--base REF] [--branch BRANCH] [--new] [--hub] [--no-service]
       [--generate [--agent NAME] [--model NAME] [--effort LEVEL]] [--print-url]
  limn open …                      same as above
  limn service <command>           background service (limn service --help)
  limn config …                    read/set the default review agent (limn config --help)
  limn --version | --help

open: review DIR (default: current directory). If a Limn service is running it
opens there; otherwise a server is started for you. --generate starts review
generation immediately (--agent/--model/--effort override it for this run only;
they need --generate and can't combine with --hub). --print-url prints the page
URL instead of opening a browser.`

export const HELP_SERVICE = `limn service — the always-on Limn server

  serve [--port N] [--port-80]   run the server in the foreground (default port 5466)
  install [--port-80]            install + start the background service (launchd / systemd --user)
  uninstall                      stop and remove the background service (database untouched)
  status                         activation, URL, pid, node path, native stop/restart commands
  logs [-f]                      show (or follow) the service log`

export const HELP_CONFIG = `limn config — read and set the default review agent

  config                          show the current agent, model and effort
  config get <agent|model|effort> print one value
  config set <key> <value>        set one value ("auto" clears model/effort)

Talks to the running Limn service when one is up, else edits its database directly.`

export async function main(argv: string[], io: Io = defaultIo()): Promise<number> {
  let cmd
  try { cmd = parseArgs(argv, process.cwd()) } catch (err) {
    if (err instanceof CliUsageError) { io.err(`limn: ${err.message}`); io.err(HELP); return 2 }
    throw err
  }
  switch (cmd.kind) {
    case 'version': io.out(`limn ${APP_VERSION}`); return 0
    case 'help': io.out(cmd.topic === 'service' ? HELP_SERVICE : cmd.topic === 'config' ? HELP_CONFIG : HELP); return 0
    case 'serve': return runServe(cmd, io)
    case 'open': return runOpen(cmd, io)
    case 'config-list': case 'config-get': case 'config-set': return runConfig(cmd, io)
    default: return runServiceCommand(cmd, io)
  }
}
