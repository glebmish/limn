import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import { registerIpc } from './ipc.js'
import { openDb } from './db/db.js'

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
      preload: path.join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(path.join(import.meta.dirname, '../renderer/index.html'))
  }

  if (process.env.LR_SHOT || process.env.ELECTRON_RENDERER_URL) {
    win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`)
    })
  }

  // dev-only visual smoke: LR_SHOT=/path.png captures the window after load
  const shot = process.env.LR_SHOT
  if (shot) {
    setTimeout(() => {
      void win.webContents.capturePage().then((img) => {
        fsWriteShot(shot, img.toPNG())
      })
    }, parseInt(process.env.LR_SHOT_DELAY ?? '9000', 10))
  }
  return win
}

app.whenReady().then(() => {
  bootstrapPath()
  const { db, recoveredFrom } = openDb(path.join(app.getPath('userData'), 'local-review.db'))
  const notices = recoveredFrom
    ? [`Database was corrupted and recreated. The old file was saved to ${recoveredFrom}.`]
    : []
  registerIpc(db, notices)
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  app.quit()
})

function fsWriteShot(p: string, buf: Buffer): void {
  fs.writeFileSync(p, buf)
}
