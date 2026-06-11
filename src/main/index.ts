import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { registerIpc } from './ipc.js'

// GUI apps on macOS don't inherit the shell PATH; engines need git/node tools from it.
function bootstrapPath(): void {
  try {
    const shell = process.env.SHELL || '/bin/zsh'
    const p = execSync(`${shell} -ilc 'echo -n "$PATH"'`, { timeout: 5000 }).toString()
    if (p) process.env.PATH = p
  } catch {
    // keep default PATH
  }
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 620,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 13 },
    backgroundColor: '#f4f3ef',
    webPreferences: {
      preload: path.join(import.meta.dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(path.join(import.meta.dirname, '../renderer/index.html'))
  }
  return win
}

app.whenReady().then(() => {
  bootstrapPath()
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  app.quit()
})
