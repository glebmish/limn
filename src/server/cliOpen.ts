import crypto from 'node:crypto'
import type { CliOpenMsg } from '../shared/ipc.js'
import { repoRoot } from './git.js'

/** An `--agent/--model/--effort` override for a `--generate` open — raw flag values,
 *  unvalidated here (validation happens where the generation is actually kicked off). */
export interface AgentOverride { engine?: string; model?: string; effort?: string }

export interface CliOpenArgs {
  dir: string
  base?: string
  /** the compare side (`--branch`) */
  compare?: string
  hub?: boolean
  fresh?: boolean
  /** `limn open --generate`: kick off generation immediately once the review loads,
   *  rather than waiting for the reviewer to click Generate. */
  generate?: boolean
  agent?: AgentOverride
  /** print the page URL instead of opening a browser (headless / scripted use). */
  printUrl?: boolean
}

/** The outcome of a CLI open request: the one-time page ticket, plus fields that
 *  only apply to a `--generate` open — `path` (once generation lands somewhere
 *  worth pointing at) and `note` (a caveat worth surfacing, e.g. a dropped override). */
export interface CliOpenResult {
  ticket: string
  path?: string
  note?: string
}

const TICKET_TTL_MS = 60_000
/** `--print-url` hands the URL to a human or a script that may take its time opening
 *  it (paste into another machine's browser, an embedded pane started later), so its
 *  ticket gets ten minutes rather than the browser-launch minute. */
export const PRINT_TICKET_TTL_MS = 600_000
const tickets = new Map<string, { msg: CliOpenMsg; expires: number }>()

/** What the kicker needs to mint a session and start a pass. Refs are the raw CLI
 *  inputs (undefined = "resolve the default"); `repo` is already the resolved root. */
export interface KickArgs {
  repo: string
  base?: string
  compare?: string
  fresh?: boolean
  agent?: AgentOverride
}

/** Installed by `registerIpc` (and cleared by `shutdownIpc`), so this module never
 *  imports the server: a CLI open that asks for generation calls back into whatever
 *  the running service registered. */
export type GenerationKicker = (args: KickArgs) => Promise<{ sessionId: number; note?: string }>

let kicker: GenerationKicker | null = null

export function setGenerationKicker(k: GenerationKicker | null): void { kicker = k }

/** Resolve the repo root for a CLI open and park the resulting message under a
 *  one-time ticket. The CLI puts the ticket in the page URL (`/?open=<ticket>`);
 *  the booting tab redeems it with takeCliOpen(). With `generate` the service also
 *  mints/reuses the session and starts the pass itself, and the answer carries the
 *  durable `/review/<id>` path the CLI opens instead of the ticket URL. */
export async function issueCliOpen(args: CliOpenArgs): Promise<CliOpenResult> {
  const root = await repoRoot(args.dir)
  const notGitRepo = `${args.dir} is not inside a git repository`
  let kicked: { sessionId: number; note?: string } | undefined
  if (args.generate) {
    // fail the CLI call outright rather than minting a ticket for a page that would
    // sit there never generating: `--generate` promises a pass actually started.
    if (!kicker) throw new Error('generation is not available on this server')
    if (!root) throw new Error(notGitRepo)
    kicked = await kicker({ repo: root, base: args.base, compare: args.compare, fresh: args.fresh, agent: args.agent })
  }
  const msg: CliOpenMsg = root
    ? { repo: root, baseInput: args.base, compareInput: args.compare, hub: args.hub, fresh: args.fresh }
    : { error: notGitRepo }
  const ticket = crypto.randomBytes(16).toString('hex')
  const now = Date.now()
  for (const [k, v] of tickets) if (v.expires < now) tickets.delete(k)
  tickets.set(ticket, { msg, expires: now + (args.printUrl ? PRINT_TICKET_TTL_MS : TICKET_TTL_MS) })
  // A ticket is minted even for a `--generate` open, but the CLI does not use it: it
  // opens the durable `path` instead. Deliberate — redeeming the ticket runs the
  // renderer's own open path, which for `--new` would mint a SECOND fresh session
  // beside the one just generated into. The ticket is the plain-open fallback only.
  return {
    ticket,
    ...(kicked ? { path: `/review/${kicked.sessionId}` } : {}),
    ...(kicked?.note ? { note: kicked.note } : {})
  }
}

/** Redeem a ticket (single use). Null for unknown, used, or expired tickets. */
export function takeCliOpen(ticket: string): CliOpenMsg | null {
  const hit = tickets.get(ticket)
  if (!hit) return null
  tickets.delete(ticket)
  return hit.expires < Date.now() ? null : hit.msg
}

/** test hooks */
export function _getGenerationKicker(): GenerationKicker | null { return kicker }
export function _resetTickets(): void { tickets.clear() }
export function _ticketCount(): number { return tickets.size }
