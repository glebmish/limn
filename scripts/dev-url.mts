/* Build the web-app URL that carries the dev/screenshot hooks (formerly LIMN_* env
 * read by the Electron preload). Prints the URL. Usage:
 *   LIMN_OPEN_SESSION=3 LIMN_FLOW=chat npx tsx scripts/dev-url.mts */
const BOOL = ['SHOW_ARCHIVED', 'SCROLL_BOTTOM', 'OPEN_PICKER', 'OPEN_WORKSPACE', 'OPEN_CMPREF', 'OPEN_CHATLIST', 'HOLD_FOCUS', 'RUN_BATCH', 'OPEN_MODE', 'FAKE_GEN', 'FAKE_DRIFT', 'FAKE_DRIFT_OPEN', 'OPEN_SETTINGS', 'SHOW_AFFORDANCES']
const STR = ['FLOW', 'OPEN_SESSION', 'OPEN_HUB', 'PICK_ENGINE', 'FOCUS', 'RUN_CHAT', 'EXPAND_TOOL', 'OPEN_DOC', 'EDIT_FRAME', 'RUN_EDIT', 'SCENARIO', 'OPEN_PEEK']
const camel = (k: string): string => k.toLowerCase().replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
  .replace('cmpref', 'CmpRef').replace('chatlist', 'ChatList')
const hooks: Record<string, unknown> = {}
for (const k of BOOL) if (process.env[`LIMN_${k}`] === '1') hooks[camel(k)] = true
for (const k of STR) if (process.env[`LIMN_${k}`]) hooks[camel(k)] = process.env[`LIMN_${k}`]
if (process.env.LIMN_ACTIVE_CHAT) hooks.activeChat = Number(process.env.LIMN_ACTIVE_CHAT)
const port = process.env.LIMN_PORT || '5466'
const q = new URLSearchParams()
if (Object.keys(hooks).length) q.set('dev', JSON.stringify(hooks))
if (process.env.LIMN_OPEN_TICKET) q.set('open', process.env.LIMN_OPEN_TICKET)
const s = q.toString()
process.stdout.write(`http://127.0.0.1:${port}/${s ? '?' + s : ''}`)
