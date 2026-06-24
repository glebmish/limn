import type { OpEventMsg, OpResultMsg, RepoChangedMsg } from '../shared/ipc.js'

/** The three server→client push streams. `cli:open` is desktop-CLI only and is
 *  pushed directly by the Electron main process, so it isn't part of this contract. */
export type BroadcastChannel = 'op:event' | 'op:result' | 'repo:changed'
export type BroadcastMsg = OpEventMsg | OpResultMsg | RepoChangedMsg

/** The seam that decouples the IPC handlers (registerIpc) from how they're carried.
 *  Electron backs this with ipcMain/BrowserWindow/Notification/dialog; the headless
 *  web server backs it with HTTP POST + Server-Sent Events. registerIpc never touches
 *  Electron directly — it only speaks Transport. */
export interface Transport {
  /** Register a request/response handler for an API channel. */
  handle(name: string, fn: (...args: unknown[]) => unknown): void
  /** Fan a push message out to every connected client (all windows / all tabs). */
  broadcast(channel: BroadcastChannel, msg: BroadcastMsg): void
  /** Surface an out-of-band notification (long agent runs finish in the background). */
  notify(title: string, body: string): void
  /** Pick a directory on the host. Electron shows a native dialog; the web server
   *  has no dialog (selection happens client-side), so it returns null. */
  pickDirectory(): Promise<string | null>
}
