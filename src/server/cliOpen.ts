import crypto from 'node:crypto'
import type { CliOpenMsg } from '../shared/ipc.js'
import { repoRoot } from './git.js'

export interface CliOpenArgs {
  dir: string
  base?: string
  /** the compare side (`--branch`) */
  compare?: string
  hub?: boolean
  fresh?: boolean
}

const TICKET_TTL_MS = 60_000
const tickets = new Map<string, { msg: CliOpenMsg; expires: number }>()

/** Resolve the repo root for a CLI open and park the resulting message under a
 *  one-time ticket. The CLI puts the ticket in the page URL (`/?open=<ticket>`);
 *  the booting tab redeems it with takeCliOpen(). */
export async function issueCliOpen(args: CliOpenArgs): Promise<{ ticket: string }> {
  const root = await repoRoot(args.dir)
  const msg: CliOpenMsg = root
    ? { repo: root, baseInput: args.base, compareInput: args.compare, hub: args.hub, fresh: args.fresh }
    : { error: `${args.dir} is not inside a git repository` }
  const ticket = crypto.randomBytes(16).toString('hex')
  const now = Date.now()
  for (const [k, v] of tickets) if (v.expires < now) tickets.delete(k)
  tickets.set(ticket, { msg, expires: now + TICKET_TTL_MS })
  return { ticket }
}

/** Redeem a ticket (single use). Null for unknown, used, or expired tickets. */
export function takeCliOpen(ticket: string): CliOpenMsg | null {
  const hit = tickets.get(ticket)
  if (!hit) return null
  tickets.delete(ticket)
  return hit.expires < Date.now() ? null : hit.msg
}

/** test hooks */
export function _resetTickets(): void { tickets.clear() }
export function _ticketCount(): number { return tickets.size }
