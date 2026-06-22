import { app, BrowserWindow, Menu } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import path from 'node:path'
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import { registerIpc } from './ipc.js'
import { openDb } from './db/db.js'
import { parseCliArgs, handleCliArgs, installCliWithDialog } from './cli.js'
import type { CliArgs } from './cli.js'

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

let mainWindow: BrowserWindow | null = null

function getWindow(): BrowserWindow | null {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow
  return null
}

function createWindow(): void {
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
      nodeIntegration: false,
      // keep painting + streaming the live agent feed while backgrounded — otherwise
      // Chromium throttles the renderer and the feed shows a stale/unpainted frame
      // when you tab away mid-generation and come back.
      backgroundThrottling: false
    }
  })

  mainWindow = win
  win.on('closed', () => { mainWindow = null })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(path.join(import.meta.dirname, '../renderer/index.html'))
  }

  if (process.env.LIMN_SHOT || process.env.ELECTRON_RENDERER_URL) {
    win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`)
    })
  }

  // dev-only visual smoke: LIMN_SHOT=/path.png captures the window after load
  // (and quits, so a harness can take several shots sequentially).
  const shot = process.env.LIMN_SHOT
  if (shot) {
    setTimeout(() => {
      void win.webContents.capturePage().then((img) => {
        fsWriteShot(shot, img.toPNG())
        if (process.env.LIMN_SHOT_QUIT) setTimeout(() => app.quit(), 200)
      })
    }, parseInt(process.env.LIMN_SHOT_DELAY ?? '9000', 10))
  }
}

function devCliArgs(): CliArgs | null {
  if (process.env.LIMN_OPEN_REPO) {
    return { dir: process.env.LIMN_OPEN_REPO, compare: process.env.LIMN_OPEN_BRANCH || undefined }
  }
  return null
}

function buildMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    {
      role: 'appMenu',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Install Command-Line Tool…', click: () => { installCliWithDialog() } },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    const win = getWindow()
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
    const args = parseCliArgs(argv)
    if (args) void handleCliArgs(args, getWindow)
  })

  app.whenReady().then(() => {
    bootstrapPath()
    // LIMN_DB (dev/screenshot only) points the app at a pre-seeded database.
    const { db, recoveredFrom } = openDb(process.env.LIMN_DB || path.join(app.getPath('userData'), 'limn.db'))
    const notices = recoveredFrom
      ? [`Database was corrupted and recreated. The old file was saved to ${recoveredFrom}.`]
      : []
    registerIpc(db, notices)
    buildMenu()
    createWindow()
    const args = parseCliArgs(process.argv) ?? devCliArgs()
    if (args) void handleCliArgs(args, getWindow)
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  app.quit()
})

function fsWriteShot(p: string, buf: Buffer): void {
  fs.writeFileSync(p, buf)
}
