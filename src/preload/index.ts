import { contextBridge, ipcRenderer } from 'electron'
import { API_CHANNELS } from '../shared/ipc.js'
import type { OpEventMsg, OpResultMsg } from '../shared/ipc.js'

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

contextBridge.exposeInMainWorld('api', api)
