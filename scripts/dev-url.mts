/* Build the web-app URL that carries the dev/screenshot hooks (formerly LIMN_* env
 * read by the Electron preload). Prints the URL. Usage:
 *   LIMN_OPEN_SESSION=3 LIMN_FLOW=chat npx tsx scripts/dev-url.mts */
import { buildDevHooks } from './dev-url-map.mjs'

const hooks = buildDevHooks(process.env)
const port = process.env.LIMN_PORT || '5466'
const q = new URLSearchParams()
if (Object.keys(hooks).length) q.set('dev', JSON.stringify(hooks))
if (process.env.LIMN_OPEN_TICKET) q.set('open', process.env.LIMN_OPEN_TICKET)
const s = q.toString()
process.stdout.write(`http://127.0.0.1:${port}/${s ? '?' + s : ''}`)
