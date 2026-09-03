/* Headless-Chrome screenshot/frames over CDP (Node 24 globals: fetch + WebSocket).
 *   npx tsx scripts/cdp-shot.mts --url http://127.0.0.1:5466/?dev=… --out /tmp/a.png [--delay 6000]
 *   npx tsx scripts/cdp-shot.mts --url … --frames /tmp/frames --every 350 --count 36 [--delay 2500]
 * `--eval "<js>"` runs in the page after the delay (a click, a state poke), then
 * `--after <ms>` (default 1500) waits for it to settle before the capture. */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const arg = (name: string, dflt?: string): string | undefined => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : dflt }
const url = arg('url'); if (!url) throw new Error('--url required')
const out = arg('out'); const frames = arg('frames')
const delay = Number(arg('delay', '6000')); const width = Number(arg('width', '1320')); const height = Number(arg('height', '860'))
const every = Number(arg('every', '400')); const count = Number(arg('count', '40'))
const evalJs = arg('eval'); const after = Number(arg('after', '1500'))

const CHROME = process.env.CHROME_BIN || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome')
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'limn-chrome-'))
const chrome = spawn(CHROME, [`--headless=new`, '--remote-debugging-port=0', `--user-data-dir=${profile}`, `--window-size=${width},${height}`, '--no-first-run', '--hide-scrollbars', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] })
let devtoolsPort = 0
chrome.stderr.on('data', (b: Buffer) => { const m = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)/.exec(b.toString()); if (m) devtoolsPort = Number(m[1]) })
let spawnError: Error | null = null
chrome.on('error', (err) => { spawnError = err })
const rmProfile = (): void => {
  // Chrome can still be flushing files to the profile dir right after kill() —
  // retry a couple of times before giving up (best-effort: a leftover tmp dir
  // isn't fatal, an uncaught exception here would be).
  for (let i = 0; i < 5; i++) {
    try { fs.rmSync(profile, { recursive: true, force: true }); return } catch { /* retry */ }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
  }
}
const cleanup = (): void => { chrome.kill(); rmProfile() }
process.on('exit', cleanup)

try {
  for (let i = 0; i < 100 && !devtoolsPort; i++) {
    if (spawnError) throw new Error(`failed to launch Chrome (${CHROME}): ${(spawnError as Error).message}`)
    await new Promise((r) => setTimeout(r, 100))
  }
  if (!devtoolsPort) throw new Error('chrome did not expose a DevTools port')
  const targets = (await (await fetch(`http://127.0.0.1:${devtoolsPort}/json`)).json()) as { type: string; webSocketDebuggerUrl: string }[]
  const page = targets.find((t) => t.type === 'page'); if (!page) throw new Error('no page target')

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error('ws error')) })
  let seq = 0
  const pending = new Map<number, (v: { result?: Record<string, unknown>; error?: { message: string } }) => void>()
  ws.onmessage = (e) => { const msg = JSON.parse(String(e.data)); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)!(msg); pending.delete(msg.id) } }
  // Per-call timeout: a Chrome that stops answering (a renderer hang, a closed target)
  // must fail the script, not park it forever behind the caller's own kill timeout.
  const send = (method: string, params: Record<string, unknown> = {}, timeoutMs = 20_000): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
    const id = ++seq
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP ${method} did not answer within ${timeoutMs}ms`)) }, timeoutMs)
    pending.set(id, (m) => { clearTimeout(timer); if (m.error) reject(new Error(m.error.message)); else resolve(m.result ?? {}) })
    ws.send(JSON.stringify({ id, method, params }))
  })

  await send('Page.enable')
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false })
  await send('Page.navigate', { url })
  await new Promise((r) => setTimeout(r, delay))
  if (evalJs) {
    const res = await send('Runtime.evaluate', { expression: evalJs, awaitPromise: true, returnByValue: true }) as { exceptionDetails?: { text: string } }
    if (res.exceptionDetails) throw new Error(`--eval failed: ${res.exceptionDetails.text}`)
    const v = (res as { result?: { value?: unknown } }).result?.value
    if (v !== undefined) console.error(`eval → ${JSON.stringify(v)}`)
    await new Promise((r) => setTimeout(r, after))
  }
  const shot = async (file: string): Promise<void> => {
    const { data } = await send('Page.captureScreenshot', { format: 'png' }) as { data: string }
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, Buffer.from(data, 'base64'))
  }
  if (frames) {
    fs.mkdirSync(frames, { recursive: true })
    for (let n = 1; n <= count; n++) { await shot(path.join(frames, `frame-${String(n).padStart(4, '0')}.png`)); await new Promise((r) => setTimeout(r, every)) }
  } else if (out) {
    await shot(out)
  } else throw new Error('--out or --frames required')
  ws.close()
} finally {
  cleanup()
}
process.exit(0)
