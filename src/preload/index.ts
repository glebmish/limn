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

// dev-only: LIMN_OPEN_REPO/LIMN_OPEN_BRANCH now flow through the CLI path (devCliArgs in main);
// LIMN_FLOW + LIMN_OPEN_SESSION (auto-resume a seeded session) are forwarded here.
contextBridge.exposeInMainWorld('limnDev', {
  flow: process.env.LIMN_FLOW ?? null,
  openSession: process.env.LIMN_OPEN_SESSION ?? null,
  // dev-only: land on the repo hub for a given repo path; scroll the review body
  // to the bottom (to capture the volatile band).
  openHub: process.env.LIMN_OPEN_HUB ?? null,
  showArchived: process.env.LIMN_SHOW_ARCHIVED === '1',
  scrollBottom: process.env.LIMN_SCROLL_BOTTOM === '1',
  // dev-only screenshot hooks: activate a specific chat, force the agent
  // picker / chat-list dropdown open so a static capture shows them.
  activeChat: process.env.LIMN_ACTIVE_CHAT ? Number(process.env.LIMN_ACTIVE_CHAT) : null,
  openPicker: process.env.LIMN_OPEN_PICKER === '1',
  openWorkspace: process.env.LIMN_OPEN_WORKSPACE === '1',
  openCmpRef: process.env.LIMN_OPEN_CMPREF === '1',
  pickEngine: process.env.LIMN_PICK_ENGINE ?? null,
  openChatList: process.env.LIMN_OPEN_CHATLIST === '1',
  focus: process.env.LIMN_FOCUS ?? null,
  holdFocus: process.env.LIMN_HOLD_FOCUS === '1',
  runBatch: process.env.LIMN_RUN_BATCH === '1',
  runChat: process.env.LIMN_RUN_CHAT ?? null,
  expandTool: process.env.LIMN_EXPAND_TOOL ?? null,
  openMode: process.env.LIMN_OPEN_MODE === '1',
  fakeGen: process.env.LIMN_FAKE_GEN === '1',
  openDoc: process.env.LIMN_OPEN_DOC ?? null,
  openPeek: process.env.LIMN_OPEN_PEEK ?? null
})
