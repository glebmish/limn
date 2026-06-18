import { contextBridge, ipcRenderer } from 'electron'
import { API_CHANNELS } from '../shared/ipc.js'
import type { CliOpenMsg, OpEventMsg, OpResultMsg, RepoChangedMsg } from '../shared/ipc.js'

const api: Record<string, unknown> = {}
for (const ch of API_CHANNELS) {
  api[ch] = (...args: unknown[]) => ipcRenderer.invoke(ch, ...args)
}

api.onOpEvent = (cb: (msg: OpEventMsg) => void) => {
  const fn = (_e: unknown, msg: OpEventMsg): void => cb(msg)
  ipcRenderer.on('op:event', fn)
  return () => ipcRenderer.removeListener('op:event', fn)
}

api.onOpResult = (cb: (msg: OpResultMsg) => void) => {
  const fn = (_e: unknown, msg: OpResultMsg): void => cb(msg)
  ipcRenderer.on('op:result', fn)
  return () => ipcRenderer.removeListener('op:result', fn)
}

api.onRepoChanged = (cb: (msg: RepoChangedMsg) => void) => {
  const fn = (_e: unknown, msg: RepoChangedMsg): void => cb(msg)
  ipcRenderer.on('repo:changed', fn)
  return () => ipcRenderer.removeListener('repo:changed', fn)
}

api.onCliOpen = (cb: (msg: CliOpenMsg) => void) => {
  const fn = (_e: unknown, msg: CliOpenMsg): void => cb(msg)
  ipcRenderer.on('cli:open', fn)
  return () => ipcRenderer.removeListener('cli:open', fn)
}

contextBridge.exposeInMainWorld('api', api)

// dev-only: LR_OPEN_REPO/LR_OPEN_BRANCH now flow through the CLI path (devCliArgs in main);
// LR_FLOW + LR_OPEN_SESSION (auto-resume a seeded session) are forwarded here.
contextBridge.exposeInMainWorld('lrDev', {
  flow: process.env.LR_FLOW ?? null,
  openSession: process.env.LR_OPEN_SESSION ?? null
})
