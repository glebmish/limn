import type { OpEventMsg, OpResultMsg, RepoChangedMsg } from '../shared/ipc.js'

/** The three server→client push streams. `cli:open` is not among them: the CLI
 *  redeems a ticket over RPC at page boot (see cliOpen.ts), it isn't pushed. */
export type BroadcastChannel = 'op:event' | 'op:result' | 'repo:changed'
export type BroadcastMsg = OpEventMsg | OpResultMsg | RepoChangedMsg

/** The seam that decouples the IPC handlers (registerIpc) from how they're carried.
 *  One backing implements it today: the HTTP service (src/server/http.ts) carries
 *  requests over POST /rpc/<channel> and pushes over the /events SSE stream. The seam
 *  stays because registerIpc must not grow a dependency on the carrier. */
export interface Transport {
  /** Register a request/response handler for an API channel. */
  handle(name: string, fn: (...args: unknown[]) => unknown): void
  /** Fan a push message out to every connected client (all windows / all tabs). */
  broadcast(channel: BroadcastChannel, msg: BroadcastMsg): void
  /** Surface an out-of-band notification (long agent runs finish in the background). */
  notify(title: string, body: string): void
  /** Pick a directory on the host. The server has no dialog to show (selection
   *  happens client-side), so it returns null; kept total for future backings. */
  pickDirectory(): Promise<string | null>
}
