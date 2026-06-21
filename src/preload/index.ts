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
  openSession: process.env.LR_OPEN_SESSION ?? null,
  // dev-only: land on the repo hub for a given repo path; scroll the review body
  // to the bottom (to capture the volatile band).
  openHub: process.env.LR_OPEN_HUB ?? null,
  showArchived: process.env.LR_SHOW_ARCHIVED === '1',
  scrollBottom: process.env.LR_SCROLL_BOTTOM === '1',
  // dev-only screenshot hooks: activate a specific chat, force the agent
  // picker / chat-list dropdown open so a static capture shows them.
  activeChat: process.env.LR_ACTIVE_CHAT ? Number(process.env.LR_ACTIVE_CHAT) : null,
  openPicker: process.env.LR_OPEN_PICKER === '1',
  openWorkspace: process.env.LR_OPEN_WORKSPACE === '1',
  openCmpRef: process.env.LR_OPEN_CMPREF === '1',
  pickEngine: process.env.LR_PICK_ENGINE ?? null,
  openChatList: process.env.LR_OPEN_CHATLIST === '1',
  focus: process.env.LR_FOCUS ?? null,
  holdFocus: process.env.LR_HOLD_FOCUS === '1',
  runBatch: process.env.LR_RUN_BATCH === '1',
  runChat: process.env.LR_RUN_CHAT ?? null,
  expandTool: process.env.LR_EXPAND_TOOL ?? null,
  openMode: process.env.LR_OPEN_MODE === '1',
  fakeGen: process.env.LR_FAKE_GEN === '1'
})
